import { fileText, validSkillPath } from "../skills/bundle";
import { Check } from "typebox/value";
import type {
  SqliteDatabase,
  SqliteExecutor,
} from "@earendil-works/pi-durable/storage/sqlite";
import type { Skill } from "../skills/skills";
import {
  schemas,
  bounded,
  check,
  fail,
  id,
  CapabilityError,
  type ToolName,
  type Args,
} from "./contracts";
import { download } from "./http";
import { migrate, query, transform, upsert } from "./database";

export type Invocation = {
  conversationId: number;
  signal: AbortSignal;
  operationId?: string;
};
export type Artifact = {
  ref: string;
  skillId?: string;
  title: string;
  mime: "text/html" | "text/plain";
  text: string;
};
export interface CapabilityOptions {
  openDatabase: (key: string) => Promise<SqliteDatabase>;
  fetcher: typeof fetch;
  skills: (conversationId: number) => Promise<Skill[]>;
  authorize: (
    conversationId: number,
    skillId: string,
    permission: string,
    signal: AbortSignal,
  ) => Promise<boolean>;
  now?: () => number;
}
// Stable UTF-8 namespace encoding is injective, unlike non-cryptographic hashes.
// Native hosts hash this key to a fixed-length filename before opening SQLite.
export const storageKey = (value: string) =>
  Array.from(new TextEncoder().encode(value), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
const randomId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
// Control characters are rejected in explicit Skill IDs, reserving this namespace.
const conversationStore = (id: number) => `\0moose-conversation:${id}`;
const setup = `CREATE TABLE IF NOT EXISTS _moose_receipts(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS _moose_objects(ref TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, meta TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS _moose_documents(name TEXT PRIMARY KEY, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS _moose_refreshes(name TEXT PRIMARY KEY, committedAt INTEGER NOT NULL);`;
export class CapabilityService {
  private databases = new Map<string, Promise<SqliteDatabase>>();
  private closed = false;
  private active = new Set<Promise<unknown>>();
  private abort = new AbortController();
  constructor(private options: CapabilityOptions) {}
  private db(skillId: string) {
    if (this.closed) fail("cancelled", "Capabilities are closed");
    let promise = this.databases.get(skillId);
    if (!promise) {
      promise = this.options
        .openDatabase(storageKey(skillId))
        .then(async (db) => {
          try {
            await db.exec(setup);
            return db;
          } catch (error) {
            await db.close();
            throw error;
          }
        });
      this.databases.set(skillId, promise);
      promise.catch(() => this.databases.delete(skillId));
    }
    return promise;
  }
  async execute(
    name: string,
    args: Record<string, unknown>,
    invocation: Invocation,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const signals = [invocation.signal, this.abort.signal];
    for (const signal of signals) {
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    }
    const pending = this.run(name, args, {
      ...invocation,
      signal: controller.signal,
    });
    this.active.add(pending);
    try {
      return await pending;
    } finally {
      this.active.delete(pending);
      for (const signal of signals) signal.removeEventListener("abort", cancel);
    }
  }
  private async run(
    name: string,
    args: Record<string, unknown>,
    ctx: Invocation,
  ): Promise<Record<string, unknown>> {
    try {
      check(ctx.signal);
      if (
        !Object.hasOwn(schemas, name) ||
        !Check(schemas[name as ToolName], args)
      )
        fail("validation", "Invalid tool arguments");
      bounded(JSON.stringify(args), 1024 * 1024);
      const skillId = args.skillId as string | undefined;
      const skill = skillId
        ? (await this.options.skills(ctx.conversationId)).find(
            (s) => s.id === skillId,
          )
        : undefined;
      if (skillId && !skill)
        return fail(
          "permission",
          "Skill must be installed and enabled in this conversation",
        );
      const authorize = async (permission: string, signal = ctx.signal) => {
        check(signal);
        if (
          !(await this.options.authorize(
            ctx.conversationId,
            skillId ?? "",
            permission,
            signal,
          ))
        )
          fail("permission", "Permission denied");
        check(signal);
        // Grants and installed selections can change while a prompt is open.
        if (
          skillId &&
          !(await this.options.skills(ctx.conversationId)).some(
            (s) => s.id === skillId,
          )
        )
          fail("permission", "Skill is no longer enabled");
      };
      if (name.startsWith("database_") || name === "json_import")
        await authorize(
          name === "database_query" || name === "database_inspect"
            ? "database:read"
            : "database:write",
        );
      if (skillId && name.startsWith("document_"))
        await authorize("documents:shared");
      const scope = skillId ? "skill-shared" : "conversation-private";
      const db = await this.db(
        skillId ?? conversationStore(ctx.conversationId),
      );
      check(ctx.signal);
      const now = this.options.now ?? Date.now;
      const mutate = async (
        input: Record<string, unknown>,
        fn: (tx: SqliteExecutor) => Promise<Record<string, unknown>>,
      ) => {
        const operationId = input.operationId as string;
        const fingerprint = JSON.stringify({
          name,
          conversationId:
            name === "artifact_create" ? ctx.conversationId : undefined,
          ...input,
        });
        return await db.transaction(async (tx) => {
          check(ctx.signal);
          const previous = await tx.get<{
            fingerprint: string;
            result: string;
          }>(
            "SELECT fingerprint,result FROM _moose_receipts WHERE id=?",
            operationId,
          );
          if (previous) {
            if (previous.fingerprint !== fingerprint)
              fail(
                "validation",
                "Operation ID already used with different input",
              );
            return JSON.parse(previous.result) as Record<string, unknown>;
          }
          const result = await fn(tx);
          check(ctx.signal);
          await tx.run(
            "INSERT INTO _moose_receipts(id,fingerprint,result) VALUES (?,?,?)",
            operationId,
            fingerprint,
            JSON.stringify(result),
          );
          check(ctx.signal);
          return result;
        });
      };
      const save = async (
        kind: string,
        text: string,
        meta: Record<string, unknown>,
        key?: string,
      ) => {
        const ref = key ?? `${kind}:${randomId()}`;
        check(ctx.signal);
        await db.run(
          "INSERT INTO _moose_objects(ref,kind,text,meta) VALUES (?,?,?,?)",
          ref,
          kind,
          text,
          JSON.stringify(meta),
        );
        return ref;
      };
      switch (name as ToolName) {
        case "http_request": {
          const ref = ctx.operationId ? `body:${ctx.operationId}` : undefined;
          if (ref) {
            const cached = await db.get<{ meta: string }>(
              "SELECT meta FROM _moose_objects WHERE ref=? AND kind='body'",
              ref,
            );
            if (cached) {
              const meta = JSON.parse(cached.meta);
              if (meta.url !== args.url)
                fail(
                  "validation",
                  "HTTP invocation ID reused with different URL",
                );
              await authorize(`http:${new URL(args.url as string).origin}`);
              return { bodyRef: ref, ...meta.result };
            }
          }
          const result = await download(
            args.url as string,
            this.options.fetcher,
            (origin, signal) => authorize(`http:${origin}`, signal),
            ctx.signal,
            8 * 1024 * 1024,
          );
          const metadata = {
            status: result.status,
            headers: result.headers,
            bytes: result.bytes,
            excerpt: result.text.slice(0, 512),
          };
          const bodyRef = await save(
            "body",
            result.text,
            { url: args.url, status: result.status, result: metadata },
            ref,
          );
          return { bodyRef, ...metadata };
        }
        case "database_schema":
          return await mutate(args, (tx) =>
            migrate(tx, args as Args<"database_schema">, ctx.signal),
          );
        case "database_write":
          return await mutate(args, (tx) =>
            upsert(
              tx,
              args.table as string,
              args.rows as Record<string, unknown>[],
              ctx.signal,
            ),
          );
        case "database_query":
          return await db.transaction((tx) =>
            query(tx, args as Args<"database_query">, ctx.signal),
          );
        case "database_inspect":
          return await db.transaction(async (tx) => {
            const tables = await tx.all<{ name: string }>(
              "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE '\\_moose\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 128",
            );
            const result = [];
            for (const table of tables) {
              check(ctx.signal);
              if (args.table && args.table !== table.name) continue;
              result.push(
                args.table
                  ? {
                      name: table.name,
                      columns: await tx.all(
                        `PRAGMA table_info(${id(table.name)})`,
                      ),
                    }
                  : { name: table.name },
              );
            }
            bounded(JSON.stringify(result), 24 * 1024);
            return {
              tables: result,
              refreshes: await tx.all(
                "SELECT name,committedAt FROM _moose_refreshes ORDER BY name LIMIT 128",
              ),
            };
          });
        case "json_import":
          return await mutate(args, async (tx) => {
            const body = await tx.get<{ text: string; meta: string }>(
              "SELECT text,meta FROM _moose_objects WHERE ref=? AND kind='body'",
              args.bodyRef as string,
            );
            if (!body)
              fail("validation", "Body reference unavailable in this skill");
            if (
              JSON.parse(body!.meta).status < 200 ||
              JSON.parse(body!.meta).status >= 300
            )
              fail("transport", "Cannot import unsuccessful HTTP response");
            let json: unknown;
            try {
              json = JSON.parse(body!.text);
            } catch {
              return fail("validation", "Body is not valid JSON");
            }
            const rows = transform(
              json,
              args as Args<"json_import">,
              ctx.signal,
            );
            const result = await upsert(
              tx,
              args.table as string,
              rows,
              ctx.signal,
            );
            const committedAt = now();
            await tx.run(
              "INSERT INTO _moose_refreshes(name,committedAt) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET committedAt=excluded.committedAt",
              args.table as string,
              committedAt,
            );
            return { ...result, committedAt };
          });
        case "document_list": {
          const offset = (args.offset as number | undefined) ?? 0;
          const documents = await db.all(
            "SELECT name,length(text) AS characters FROM _moose_documents ORDER BY name LIMIT 51 OFFSET ?",
            offset,
          );
          return {
            scope,
            documents: documents.slice(0, 50),
            nextOffset: documents.length > 50 ? offset + 50 : null,
          };
        }
        case "document_read": {
          const row = await db.get<{ text: string }>(
            "SELECT text FROM _moose_documents WHERE name=?",
            args.name as string,
          );
          if (!row) fail("validation", "Document not found");
          return {
            scope,
            name: args.name,
            ...this.page(row!.text, args),
          };
        }
        case "document_write":
        case "document_edit":
          return await mutate(args, async (tx) => {
            let text = args.text as string;
            if (name === "document_edit") {
              const row = await tx.get<{ text: string }>(
                "SELECT text FROM _moose_documents WHERE name=?",
                args.name as string,
              );
              const old = args.oldText as string;
              if (
                !row ||
                row.text.indexOf(old) < 0 ||
                row.text.indexOf(old) !== row.text.lastIndexOf(old)
              )
                fail("validation", "Edit must match exactly one occurrence");
              text = row!.text.replace(old, () => args.newText as string);
            }
            bounded(text, 512 * 1024);
            await tx.run(
              "INSERT INTO _moose_documents(name,text) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET text=excluded.text",
              args.name as string,
              text,
            );
            return { scope, name: args.name };
          });
        case "artifact_create":
          return await mutate(args, async (tx) => {
            bounded(args.text as string, 512 * 1024);
            const ref = `artifact:${randomId()}`;
            await tx.run(
              "INSERT INTO _moose_objects(ref,kind,text,meta) VALUES (?,'artifact',?,?)",
              ref,
              args.text as string,
              JSON.stringify({
                conversationId: ctx.conversationId,
                title: args.title,
                mime: args.mime,
              }),
            );
            return {
              ref,
              title: args.title,
              mime: args.mime,
              scope: "conversation",
              open: "Open this conversation’s artifacts to preview or share",
            };
          });
        case "skill_resource_read": {
          if (!skill)
            return fail("permission", "Skill must be installed and enabled");
          const path = args.path as string;
          if (path === "SKILL.md")
            return {
              path,
              ...this.page(skill.instructions, args),
              source: "installed",
            };
          if (skill.files) {
            if (!validSkillPath(path))
              fail("validation", "Invalid installed resource path");
            const file = skill.files.find((f) => f.path === path);
            if (!file)
              return fail(
                "validation",
                "File is not in the installed Skill folder",
              );
            const text = fileText(file);
            if (text === undefined)
              return fail(
                "validation",
                "Binary resource; use skill_workspace for exact file bytes",
              );
            return { path, ...this.page(text, args), source: "installed" };
          }
          if (
            !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(md|txt|json|html|csv)$/.test(
              path,
            ) ||
            path.split("/").some((s) => s === "." || s === "..")
          )
            fail("validation", "Resource must be a relative text reference");
          const ref = `resource:${path}`;
          const cached = await db.get<{ text: string }>(
            "SELECT text FROM _moose_objects WHERE ref=? AND kind='resource'",
            ref,
          );
          if (cached)
            return {
              path,
              ...this.page(cached.text, args),
              source: "installed-cache",
            };
          const result = await download(
            new URL(path, skill.source).href,
            this.options.fetcher,
            (origin, signal) => authorize(`http:${origin}`, signal),
            ctx.signal,
            128 * 1024,
          );
          if (result.status < 200 || result.status >= 300)
            fail("transport", "Resource download failed");
          if (
            result.headers["content-type"] &&
            !/^(text\/|application\/(json|schema\+json|octet-stream))/.test(
              result.headers["content-type"],
            )
          )
            fail("validation", "Resource is not text");
          check(ctx.signal);
          await db.run(
            "INSERT OR IGNORE INTO _moose_objects(ref,kind,text,meta) VALUES (?,'resource',?,'{}')",
            ref,
            result.text,
          );
          return {
            path,
            ...this.page(result.text, args),
            source: "downloaded",
          };
        }
      }
      return fail("validation", "Unknown tool");
    } catch (error) {
      if (error instanceof CapabilityError) throw error;
      if (ctx.signal.aborted) fail("cancelled", "Operation cancelled");
      return fail("database", "Capability storage operation failed");
    }
  }
  private page(text: string, args: Record<string, unknown>) {
    const offset = (args.offset as number | undefined) ?? 0;
    const part = text.slice(offset, offset + 4096);
    return {
      text: part,
      offset,
      nextOffset:
        offset + part.length < text.length ? offset + part.length : null,
      characters: text.length,
    };
  }
  async artifacts(conversationId: number): Promise<Omit<Artifact, "text">[]> {
    const skills: { id: string; skillId?: string }[] = [
      { id: conversationStore(conversationId) },
      ...(await this.options.skills(conversationId)).map((skill) => ({
        id: skill.id,
        skillId: skill.id,
      })),
    ];
    const results: Omit<Artifact, "text">[] = [];
    for (const skill of skills) {
      const db = await this.db(skill.id);
      const rows = await db.all<{ ref: string; meta: string }>(
        "SELECT ref,meta FROM _moose_objects WHERE kind='artifact' AND json_extract(meta,'$.conversationId')=? ORDER BY rowid DESC LIMIT 200",
        conversationId,
      );
      for (const row of rows) {
        const meta = JSON.parse(row.meta);
        if (meta.conversationId === conversationId)
          results.push({
            ref: row.ref,
            skillId: skill.skillId,
            title: meta.title,
            mime: meta.mime,
          });
      }
    }
    return results;
  }
  async artifact(conversationId: number, ref: string): Promise<Artifact> {
    const stores: { id: string; skillId?: string }[] = [
      { id: conversationStore(conversationId) },
      ...(await this.options.skills(conversationId)).map((skill) => ({
        id: skill.id,
        skillId: skill.id,
      })),
    ];
    for (const skill of stores) {
      const row = await (
        await this.db(skill.id)
      ).get<{ text: string; meta: string }>(
        "SELECT text,meta FROM _moose_objects WHERE ref=? AND kind='artifact'",
        ref,
      );
      if (row) {
        const meta = JSON.parse(row.meta);
        if (meta.conversationId === conversationId)
          return {
            ref,
            skillId: skill.skillId,
            title: meta.title,
            mime: meta.mime,
            text: row.text,
          };
      }
    }
    return fail("permission", "Artifact unavailable in this conversation");
  }

  async close() {
    if (this.closed) return;
    this.abort.abort();
    await Promise.allSettled([...this.active]);
    this.closed = true;
    const opened = await Promise.allSettled([...this.databases.values()]);
    this.databases.clear();
    for (const result of opened)
      if (result.status === "fulfilled") await result.value.close();
  }
}
