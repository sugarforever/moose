import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityService } from "../src/capabilities/service";
import { SerialSqliteDatabase } from "../src/storage/database";
import type { Skill } from "../src/skills/skills";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
export function sqlite(path: string) {
  const db = new DatabaseSync(path);
  return new SerialSqliteDatabase({
    execAsync: async (sql) => {
      db.exec(sql);
    },
    runAsync: async (sql, ...p) => {
      db.prepare(sql).run(...p);
    },
    getFirstAsync: async (sql, ...p) =>
      (db.prepare(sql).get(...p) as never) ?? null,
    getAllAsync: async (sql, ...p) => db.prepare(sql).all(...p) as never,
    closeAsync: async () => db.close(),
  });
}
const skill: Skill = {
  id: "skill-a",
  name: "Test",
  description: "",
  instructions: "Use tools",
  source: "https://example.com/skills/SKILL.md",
  installedAt: 0,
};
async function fixture(
  fetcher: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        elements: [
          { id: 1, name: "A", cost: "5.5" },
          { id: 2, name: "B", cost: "6" },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    ),
) {
  const root = await mkdtemp(join(tmpdir(), "moose-tools-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const requests: string[] = [];
  let allow = true;
  const grants = new Set<string>();
  const options = {
    openDatabase: async (id: string) => sqlite(join(root, `${id}.sqlite`)),
    fetcher,
    skills: async (chat: number) =>
      chat === 99 ? [] : [skill, { ...skill, id: "skill-b" }],
    authorize: async (
      _chat: number,
      _skill: string,
      permission: string,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      requests.push(permission);
      return allow;
    },
    now: () => 1234,
  };
  const service = new CapabilityService(options);
  cleanups.push(() => service.close());
  const signal = new AbortController().signal;
  const invoke = (name: string, args: Record<string, unknown> = {}, chat = 1) =>
    service.execute(
      name,
      { skillId: skill.id, ...args },
      { conversationId: chat, signal },
    );
  return {
    service,
    options,
    invoke,
    signal,
    requests,
    deny: () => {
      allow = false;
    },
    grants,
  };
}
const schema = {
  operationId: "schema-1",
  tables: [
    {
      name: "players",
      columns: [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "name", type: "TEXT" },
        { name: "cost", type: "REAL" },
        { name: "team", type: "INTEGER" },
      ],
    },
  ],
};
const mapping = {
  table: "players",
  select: ["elements"],
  columns: {
    id: { path: ["id"], type: "number" },
    name: { path: ["name"], type: "string" },
    cost: { path: ["cost"], type: "number" },
    team: { constant: 42, type: "number" },
  },
};

it("fetches by reference, imports transactionally, returns bounded SQL and replays after reopen", async () => {
  const f = await fixture();
  const body = await f.invoke("http_request", {
    url: "https://example.com/bootstrap",
  });
  expect(body.bodyRef).toBeTypeOf("string");
  await f.invoke("database_schema", schema);
  const args = { ...mapping, bodyRef: body.bodyRef, operationId: "refresh-1" };
  const imported = await f.invoke("json_import", args);
  expect(imported).toMatchObject({ rows: 2, committedAt: 1234 });
  const queried = await f.invoke("database_query", {
    table: "players",
    columns: ["name", "cost", "team"],
    where: [{ column: "cost", op: ">", value: 5 }],
    limit: 1,
  });
  expect(queried.rows).toEqual([{ name: "A", cost: 5.5, team: 42 }]);
  expect(queried.sql).toContain("SELECT");
  await f.service.close();
  const reopened = new CapabilityService(f.options);
  cleanups.push(() => reopened.close());
  expect(
    await reopened.execute(
      "json_import",
      { skillId: skill.id, ...args },
      { conversationId: 1, signal: f.signal },
    ),
  ).toEqual(imported);
  await expect(
    reopened.execute(
      "json_import",
      { skillId: skill.id, ...args, table: "other" },
      { conversationId: 1, signal: f.signal },
    ),
  ).rejects.toMatchObject({ code: "validation" });
});
it("rolls back invalid batches and never records a successful refresh", async () => {
  const f = await fixture(
    async () =>
      new Response('{"elements":[{"id":1,"cost":"4"},{"id":2,"cost":"oops"}]}'),
  );
  await f.invoke("database_schema", schema);
  const body = await f.invoke("http_request", {
    url: "https://example.com/data",
  });
  await expect(
    f.invoke("json_import", {
      ...mapping,
      bodyRef: body.bodyRef,
      operationId: "bad",
    }),
  ).rejects.toMatchObject({ code: "validation" });
  expect((await f.invoke("database_query", { table: "players" })).rows).toEqual(
    [],
  );
  expect((await f.invoke("database_inspect")).refreshes).toEqual([]);
});
it("enforces enabled skills, denial, isolation, reserved names and bounded query results", async () => {
  const f = await fixture();
  await expect(f.invoke("database_inspect", {}, 99)).rejects.toMatchObject({
    code: "permission",
  });
  f.deny();
  await expect(
    f.invoke("http_request", { url: "https://example.com" }),
  ).rejects.toMatchObject({ code: "permission" });
  await expect(f.invoke("database_inspect")).rejects.toMatchObject({
    code: "permission",
  });
  const g = await fixture();
  await g.invoke("database_schema", schema);
  expect(
    (await g.invoke("database_inspect", { skillId: "skill-b" })).tables,
  ).toEqual([]);
  await expect(
    g.invoke("database_query", { table: "_moose_receipts" }),
  ).rejects.toMatchObject({ code: "validation" });
  await expect(
    g.invoke("database_query", { table: "players", limit: 201 }),
  ).rejects.toMatchObject({ code: "validation" });
  await expect(
    g.invoke("database_query", { table: "players; DROP TABLE players" }),
  ).rejects.toMatchObject({ code: "validation" });
});
it("checks redirect grants before following, rejects insecure redirects and oversized bodies", async () => {
  const urls: string[] = [];
  const f = await fixture(async (input) => {
    urls.push(String(input));
    return new Response(null, {
      status: 302,
      headers: { location: "http://private.local/" },
    });
  });
  await expect(
    f.invoke("http_request", { url: "https://example.com" }),
  ).rejects.toMatchObject({ code: "permission" });
  expect(urls).toHaveLength(1);
  const g = await fixture(
    async () =>
      new Response("x", {
        headers: { "content-length": String(9 * 1024 * 1024) },
      }),
  );
  await expect(
    g.invoke("http_request", { url: "https://example.com" }),
  ).rejects.toMatchObject({ code: "limit" });
});
it("cancels pending network operations without committing a body", async () => {
  const f = await fixture(
    async (_input, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("native secret")),
          { once: true },
        ),
      ),
  );
  const controller = new AbortController();
  const result = f.service.execute(
    "http_request",
    { skillId: skill.id, url: "https://example.com" },
    { conversationId: 1, signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 10);
  await expect(result).rejects.toMatchObject({ code: "cancelled" });
});
it("persists shared documents and artifacts with conflict-safe replay and cross-chat scope", async () => {
  const f = await fixture();
  const written = await f.invoke("document_write", {
    name: "squad.json",
    text: '{"team":42}',
    operationId: "doc-1",
  });
  expect(written.scope).toBe("skill-shared");
  expect(
    (await f.invoke("document_read", { name: "squad.json" }, 2)).text,
  ).toBe('{"team":42}');
  expect((await f.invoke("document_list", {}, 2)).documents).toHaveLength(1);
  await f.invoke("document_edit", {
    name: "squad.json",
    oldText: "42",
    newText: "43",
    operationId: "doc-2",
  });
  expect(
    (await f.invoke("document_read", { name: "squad.json" })).text,
  ).toContain("43");
  await expect(
    f.invoke("document_write", {
      name: "squad.json",
      text: "bad",
      operationId: "doc-1",
    }),
  ).rejects.toMatchObject({ code: "validation" });
  const artifact = await f.invoke("artifact_create", {
    title: "Report",
    text: "<h1>Squad</h1>",
    mime: "text/html",
    operationId: "report-1",
  });
  expect(artifact.ref).toMatch(/^artifact:/);
  expect(await f.service.artifacts(1)).toHaveLength(1);
  expect(await f.service.artifacts(2)).toHaveLength(0);
  expect((await f.service.artifact(1, String(artifact.ref))).text).toContain(
    "Squad",
  );
  await expect(
    f.service.artifact(2, String(artifact.ref)),
  ).rejects.toMatchObject({ code: "permission" });
});
it("reads installed instructions and bounded relative resources without executing them", async () => {
  const f = await fixture(
    async () =>
      new Response('{"type":"object"}', {
        headers: { "content-type": "application/json" },
      }),
  );
  expect(
    (await f.invoke("skill_resource_read", { path: "SKILL.md" })).text,
  ).toBe("Use tools");
  expect(
    (await f.invoke("skill_resource_read", { path: "templates/schema.json" }))
      .text,
  ).toContain('"object"');
  await expect(
    f.invoke("skill_resource_read", { path: "../escape" }),
  ).rejects.toMatchObject({ code: "validation" });
});
it("rolls back a native write failure after an earlier row and allows retry with the same operation ID", async () => {
  const f = await fixture();
  await f.invoke("database_schema", schema);
  await expect(
    f.invoke("database_write", {
      operationId: "batch",
      table: "players",
      rows: [
        { id: 1, name: "A" },
        { id: "bad", name: "B" },
      ],
    }),
  ).rejects.toMatchObject({ code: "database" });
  expect((await f.invoke("database_query", { table: "players" })).rows).toEqual(
    [],
  );
  await f.invoke("database_write", {
    operationId: "batch",
    table: "players",
    rows: [{ id: 1, name: "Fixed" }],
  });
  expect((await f.invoke("database_query", { table: "players" })).rows).toEqual(
    [{ id: 1, name: "Fixed", cost: null, team: null }],
  );
});
it("authorizes every redirect origin, omits credentials and handles Android manual redirect metadata", async () => {
  const requested: string[] = [];
  let call = 0;
  const f = await fixture(async (input, init) => {
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("manual");
    requested.push(String(input));
    if (call++ === 0) {
      const response = new Response(null, {
        status: 302,
        headers: { location: "https://other.example.com/final" },
      });
      Object.defineProperty(response, "redirected", { value: true });
      return response;
    }
    return new Response("OK", {
      headers: { "set-cookie": "private", "content-type": "text/plain" },
    });
  });
  const result = await f.invoke("http_request", {
    url: "https://example.com/start",
  });
  expect(requested).toHaveLength(2);
  expect(f.requests).toEqual([
    "http:https://example.com",
    "http:https://other.example.com",
  ]);
  expect(result.headers).toEqual({ "content-type": "text/plain" });
});
it("rejects cross-skill body references and pages large documents without exceeding output bounds", async () => {
  const f = await fixture();
  const body = await f.invoke("http_request", { url: "https://example.com" });
  await f.invoke("database_schema", { ...schema, skillId: "skill-b" });
  await expect(
    f.invoke("json_import", {
      ...mapping,
      bodyRef: body.bodyRef,
      operationId: "cross",
      skillId: "skill-b",
    }),
  ).rejects.toMatchObject({ code: "validation" });
  await f.invoke("document_write", {
    name: "large",
    text: "界".repeat(10000),
    operationId: "large",
  });
  const first = await f.invoke("document_read", { name: "large" });
  expect(first.nextOffset).toBe(4096);
  expect(JSON.stringify(first).length).toBeLessThan(5000);
  const next = await f.invoke("document_read", {
    name: "large",
    offset: first.nextOffset,
  });
  expect(next.offset).toBe(4096);
});
it("cancels after a native row write and rolls back the row and receipt", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let interrupt = false;
  const service = new CapabilityService({
    ...f.options,
    openDatabase: async (key) => {
      const db = await f.options.openDatabase(`interrupt-${key}`);
      const transaction = db.transaction.bind(db);
      db.transaction = (callback) =>
        transaction((tx) =>
          callback({
            ...tx,
            run: async (sql, ...params) => {
              await tx.run(sql, ...params);
              if (interrupt && sql.startsWith('INSERT INTO "players"')) {
                interrupt = false;
                controller.abort();
              }
            },
          }),
        );
      return db;
    },
  });
  cleanups.push(() => service.close());
  const invoke = (
    name: string,
    args: Record<string, unknown>,
    signal = f.signal,
  ) =>
    service.execute(
      name,
      { skillId: skill.id, ...args },
      { conversationId: 1, signal },
    );
  await invoke("database_schema", schema);
  interrupt = true;
  const args = {
    table: "players",
    rows: [
      { id: 1, name: "A" },
      { id: 2, name: "B" },
    ],
    operationId: "interrupted",
  };
  await expect(
    invoke("database_write", args, controller.signal),
  ).rejects.toMatchObject({ code: "cancelled" });
  expect((await invoke("database_query", { table: "players" })).rows).toEqual(
    [],
  );
  expect(await invoke("database_write", args)).toMatchObject({ rows: 2 });
});
it("reuses a stable HTTP tool receipt after recovery without issuing another request", async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    return new Response("data");
  });
  const ctx = { conversationId: 1, signal: f.signal, operationId: "tool-123" };
  const first = await f.service.execute(
    "http_request",
    { skillId: skill.id, url: "https://example.com/data" },
    ctx,
  );
  expect(
    await f.service.execute(
      "http_request",
      { skillId: skill.id, url: "https://example.com/data" },
      ctx,
    ),
  ).toEqual(first);
  expect(calls).toBe(1);
});

it("runs the same generated-runtime fixture used on device", async () => {
  const { runCapabilitySmoke } = await import("../src/dev/capabilities-smoke");
  const f = await fixture();
  const result = await runCapabilitySmoke((key) =>
    f.options.openDatabase(`smoke-${key}`),
  );
  expect(result.checks).toHaveLength(10);
});
it("keeps artifacts discoverable when other conversations have more than 200 newer artifacts", async () => {
  const f = await fixture();
  const first = await f.invoke("artifact_create", {
    title: "First",
    text: "saved",
    mime: "text/plain",
    operationId: "first",
  });
  for (let n = 0; n < 201; n++)
    await f.invoke(
      "artifact_create",
      {
        title: `Other ${n}`,
        text: "other",
        mime: "text/plain",
        operationId: `other-${n}`,
      },
      2,
    );
  expect((await f.service.artifacts(1)).map((a) => a.ref)).toContain(first.ref);
  expect((await f.service.artifact(1, String(first.ref))).text).toBe("saved");
});
it("bounds the entire query result even with large parameter values", async () => {
  const f = await fixture();
  await f.invoke("database_schema", schema);
  const result = await f.invoke("database_query", {
    table: "players",
    where: Array.from({ length: 16 }, () => ({
      column: "name",
      op: "!=",
      value: "x".repeat(8192),
    })),
  });
  expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(
    32768,
  );
});
it("creates references on Hermes with getRandomValues and no randomUUID", async () => {
  const cryptoBefore = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", {
    value: { getRandomValues: cryptoBefore.getRandomValues.bind(cryptoBefore) },
    configurable: true,
  });
  try {
    const f = await fixture();
    expect(
      (await f.invoke("http_request", { url: "https://example.com" })).bodyRef,
    ).toMatch(/^body:/);
  } finally {
    Object.defineProperty(globalThis, "crypto", {
      value: cryptoBefore,
      configurable: true,
    });
  }
});
it("allows focused schema inspection without returning an unbounded whole database schema", async () => {
  const f = await fixture();
  await f.invoke("database_schema", schema);
  const result = await f.invoke("database_inspect", { table: "players" });
  expect(JSON.stringify(result.tables)).toContain('"name":"cost"');
});
it("enumerates shared documents in bounded pages", async () => {
  const f = await fixture();
  for (let i = 0; i < 51; i++)
    await f.invoke("document_write", {
      name: `${String(i).padStart(2, "0")}-${"界".repeat(120)}`,
      text: "",
      operationId: `page-${i}`,
    });
  const page = await f.invoke("document_list");
  expect(page.documents).toHaveLength(50);
  expect(page.nextOffset).toBe(50);
  expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThan(
    32768,
  );
  expect(
    (await f.invoke("document_list", { offset: page.nextOffset })).documents,
  ).toHaveLength(1);
});

it("runs general tools without any enabled Skill using conversation-local data and grants", async () => {
  const f = await fixture();
  const grants: { chat: number; owner: string; permission: string }[] = [];
  const service = new CapabilityService({
    ...f.options,
    authorize: async (chat, owner, permission) => {
      grants.push({ chat, owner, permission });
      return true;
    },
  });
  cleanups.push(() => service.close());
  const run = (name: string, args: Record<string, unknown> = {}, chat = 99) =>
    service.execute(name, args, { conversationId: chat, signal: f.signal });
  const body = await run("http_request", {
    url: "https://example.com/bootstrap",
  });
  await run("database_schema", schema);
  expect(
    await run("json_import", {
      ...mapping,
      bodyRef: body.bodyRef,
      operationId: "local-import",
    }),
  ).toMatchObject({ rows: 2 });
  expect((await run("database_query", { table: "players" })).rows).toHaveLength(
    2,
  );
  expect(
    await run("document_write", {
      name: "note",
      text: "private",
      operationId: "note",
    }),
  ).toMatchObject({ scope: "conversation-private" });
  expect((await run("document_read", { name: "note" })).text).toBe("private");
  const artifact = await run("artifact_create", {
    title: "Report",
    text: "local",
    mime: "text/plain",
    operationId: "report",
  });
  expect((await service.artifact(99, String(artifact.ref))).text).toBe("local");
  expect((await service.artifacts(99)).map((a) => a.ref)).toContain(
    artifact.ref,
  );
  expect(await service.artifacts(100)).toEqual([]);
  await expect(
    run("document_read", { name: "note" }, 100),
  ).rejects.toMatchObject({ code: "validation" });
  expect((await run("database_inspect", {}, 100)).tables).toEqual([]);
  expect(
    grants.some(
      (g) =>
        g.chat === 99 &&
        g.owner === "" &&
        g.permission === "http:https://example.com",
    ),
  ).toBe(true);
  expect(grants.some((g) => g.permission === "documents:shared")).toBe(false);
  await expect(
    run("http_request", { skillId: "missing", url: "https://example.com" }),
  ).rejects.toMatchObject({ code: "permission" });
  await expect(
    run("skill_resource_read", { path: "SKILL.md" }),
  ).rejects.toMatchObject({ code: "validation" });
});
it("keeps conversation and Skill body references isolated and still enforces general HTTP denial", async () => {
  const f = await fixture();
  const run = (name: string, args: Record<string, unknown>, chat: number) =>
    f.service.execute(name, args, { conversationId: chat, signal: f.signal });
  const body = await run("http_request", { url: "https://example.com" }, 99);
  await run("database_schema", schema, 100);
  await expect(
    run(
      "json_import",
      { ...mapping, bodyRef: body.bodyRef, operationId: "foreign" },
      100,
    ),
  ).rejects.toMatchObject({ code: "validation" });
  await f.invoke("database_schema", schema);
  await expect(
    f.invoke("json_import", {
      ...mapping,
      bodyRef: body.bodyRef,
      operationId: "foreign",
    }),
  ).rejects.toMatchObject({ code: "validation" });
  f.deny();
  await expect(
    run("http_request", { url: "https://example.com" }, 99),
  ).rejects.toMatchObject({ code: "permission" });
});
it("reopens conversation-local data and never accepts a Skill ID in the reserved namespace", async () => {
  const f = await fixture();
  const ctx = { conversationId: 99, signal: f.signal };
  const saved = await f.service.execute(
    "artifact_create",
    {
      title: "Local",
      text: "saved",
      mime: "text/plain",
      operationId: "persist",
    },
    ctx,
  );
  await f.service.close();
  const reopened = new CapabilityService(f.options);
  cleanups.push(() => reopened.close());
  expect((await reopened.artifact(99, String(saved.ref))).text).toBe("saved");
  await expect(
    reopened.execute(
      "http_request",
      { skillId: "\u0000moose-conversation:99", url: "https://example.com" },
      ctx,
    ),
  ).rejects.toMatchObject({ code: "validation" });
});
