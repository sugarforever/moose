import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { MobileEngine } from "../src/runtime/engine";
import { SerialSqliteDatabase } from "../src/storage/database";
const opened: MobileEngine[] = [];
afterEach(async () => {
  for (const e of opened.splice(0)) await e.close();
});
function db() {
  const native = new DatabaseSync(":memory:");
  return new SerialSqliteDatabase({
    execAsync: async (sql) => {
      native.exec(sql);
    },
    runAsync: async (sql, ...p) => {
      native.prepare(sql).run(...p);
    },
    getFirstAsync: async (sql, ...p) =>
      (native.prepare(sql).get(...p) as never) ?? null,
    getAllAsync: async (sql, ...p) => native.prepare(sql).all(...p) as never,
    closeAsync: async () => native.close(),
  });
}
it("advertises validated contracts and executes actual Pi tools without a shell", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const engine = await MobileEngine.open(
    db(),
    models,
    { provider: "faux", modelId: "faux-1" },
    Date.now,
    undefined,
    {
      openDatabase: async () => db(),
      fetcher: async () => new Response('{"items":[{"id":1,"cost":"5"}]}'),
      authorize: async () => true,
    },
  );
  opened.push(engine);
  await engine.installSkill({
    id: "test",
    name: "Test",
    source: "https://example.com/SKILL.md",
    instructions: "Use native tools",
    description: "",
    installedAt: 0,
  });
  const chat = await engine.newConversation();
  await engine.toggleSkill(chat.id, "test");
  const call = (
    name: string,
    args: Record<string, import("@earendil-works/chord").JsonValue>,
  ) =>
    fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
  faux.setResponses([
    call("capabilities", {}),
    call("database_schema", {
      skillId: "test",
      operationId: "setup",
      tables: [
        {
          name: "players",
          columns: [
            { name: "id", type: "INTEGER", primaryKey: true },
            { name: "cost", type: "REAL" },
          ],
        },
      ],
    }),
    call("database_write", {
      skillId: "test",
      operationId: "write",
      table: "players",
      rows: [{ id: 1, cost: 5 }],
    }),
    call("database_query", { skillId: "test", table: "players" }),
    call("database_query", { skillId: "test", table: "players", limit: 999 }),
    fauxAssistantMessage("Done"),
  ]);
  expect(
    (
      await (
        await engine.submit(chat.id, "Save and query", "tools")
      ).wait(engine.context)
    ).status,
  ).toBe("done");
  const view = await chat.context(engine.context);
  const text = JSON.stringify(view.entries);
  expect(text).toContain("cost");
  expect(text).toContain("SELECT");
  expect(text).toContain("skill_resource_read");
  const results = view.entries
    .flatMap((e) => e.model ?? [])
    .filter((m) => m.role === "toolResult");
  expect(results.filter((r) => r.isError)).toHaveLength(1);
  expect(
    (await chat.agent(engine.context)).tools.map((t) => t.name),
  ).not.toContain("bash");
});

it("offers and executes HTTP fetching for an ordinary conversation with no Skills", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const grants: string[] = [];
  const engine = await MobileEngine.open(
    db(),
    models,
    { provider: "faux", modelId: "faux-1" },
    Date.now,
    undefined,
    {
      openDatabase: async () => db(),
      fetcher: async () => new Response("Public article"),
      authorize: async (_chat, owner, permission) => {
        grants.push(`${owner}|${permission}`);
        return true;
      },
    },
  );
  opened.push(engine);
  const chat = await engine.newConversation();
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("http_request", { url: "https://example.com/article" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Fetched"),
  ]);
  expect(
    (
      await (
        await engine.submit(chat.id, "Fetch this URL", "general-http")
      ).wait(engine.context)
    ).status,
  ).toBe("done");
  const results = (await chat.context(engine.context)).entries
    .flatMap((e) => e.model ?? [])
    .filter((m) => m.role === "toolResult");
  expect(results).toHaveLength(1);
  expect(results[0].isError).toBeFalsy();
  expect(JSON.stringify(results)).toContain("Public article");
  expect(grants).toEqual(["|http:https://example.com"]);
});

it("Termux hides duplicate executors while preserving report creation and Skill resource tools", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const engine = await MobileEngine.open(
    db(),
    models,
    { provider: "faux", modelId: "faux-1" },
    Date.now,
    undefined,
    {
      openDatabase: async () => db(),
      fetcher: async () => new Response("{}"),
      authorize: async () => true,
    },
    { shell: true },
  );
  opened.push(engine);
  const chat = await engine.newConversation();
  const names = (await chat.agent(engine.context)).tools
    .map((t) => t.name)
    .sort();
  expect(names).toEqual([
    "artifact_create",
    "capabilities",
    "skill_resource_read",
  ]);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("capabilities", {}), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(
      fauxToolCall("artifact_create", {
        operationId: "report",
        title: "Termux report",
        text: "<h1>Report</h1>",
        mime: "text/html",
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done"),
  ]);
  expect(
    (
      await (
        await engine.submit(chat.id, "Publish this report", "termux-report")
      ).wait(engine.context)
    ).status,
  ).toBe("done");
  expect(await engine.capabilities!.artifacts(chat.id)).toMatchObject([
    { title: "Termux report" },
  ]);
  const context = JSON.stringify((await chat.context(engine.context)).entries);
  expect(context).not.toContain("No shell or eval");
  expect(context).not.toContain("database_query");
});

it("preserves native data and restores tools after switching local to Termux and back", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { sqlite } = await import("./helpers/capability-db");
  const root = await mkdtemp(join(tmpdir(), "moose-switch-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const open = (shell: boolean) =>
    MobileEngine.open(
      sqlite(join(root, "pi.sqlite")),
      models,
      { provider: "faux", modelId: "faux-1" },
      Date.now,
      undefined,
      {
        openDatabase: async (key) =>
          sqlite(
            join(
              root,
              createHash("sha256").update(key).digest("hex") + ".sqlite",
            ),
          ),
        fetcher: async () => new Response("{}"),
        authorize: async () => true,
      },
      { shell },
    );
  let engine: MobileEngine | undefined;
  try {
    engine = await open(false);
    const chat = await engine.newConversation();
    const operation = {
      conversationId: Number(chat.id),
      operationId: "save",
      signal: new AbortController().signal,
    };
    await engine.capabilities!.execute(
      "document_write",
      { name: "legacy", text: "keep me", operationId: "save" },
      operation,
    );
    await engine.close();
    engine = await open(true);
    expect(
      (
        await (await engine.conversation(chat.id)).agent(engine.context)
      ).tools.map((t) => t.name),
    ).not.toContain("document_write");
    expect(
      await engine.capabilities!.execute(
        "document_read",
        { name: "legacy" },
        operation,
      ),
    ).toMatchObject({ text: "keep me" });
    await engine.close();
    engine = await open(false);
    expect(
      (
        await (await engine.conversation(chat.id)).agent(engine.context)
      ).tools.map((t) => t.name),
    ).toContain("document_write");
    expect(
      await engine.capabilities!.execute(
        "document_read",
        { name: "legacy" },
        operation,
      ),
    ).toMatchObject({ text: "keep me" });
  } finally {
    await engine?.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("iSH exposes its durable bash tool while retaining approved native executors", async () => {
  const { createIshWorkspace } = await import("../src/runtime/ish");
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const factory = Object.assign(
    (id: string) =>
      createIshWorkspace(id, {
        prepare: async () => {},
        execute: async () => {
          throw new Error("No guest execution expected");
        },
        cancel: async () => {},
        cleanup: async () => {},
        subscribe: () => () => {},
      }),
    { shell: true },
  );
  const engine = await MobileEngine.open(
    db(),
    models,
    { provider: "faux", modelId: "faux-1" },
    Date.now,
    factory,
    {
      openDatabase: async () => db(),
      fetcher: async () => new Response("{}"),
      authorize: async () => true,
    },
  );
  opened.push(engine);
  const chat = await engine.newConversation();
  const names = (await chat.agent(engine.context)).tools.map((t) => t.name);
  expect(names).toContain("bash");
  expect(names).toContain("http_request");
  expect(names).toContain("database_query");
  expect(names).toContain("artifact_create");
  faux.setResponses([fauxAssistantMessage("Ready")]);
  expect(
    (
      await (
        await engine.submit(chat.id, "Describe available tools", "ish-profile")
      ).wait(engine.context)
    ).status,
  ).toBe("done");
  const context = JSON.stringify((await chat.context(engine.context)).entries);
  expect(context).toContain("iSH POSIX shell");
  expect(context).not.toContain("Termux workspace");
  expect(context).not.toContain("No shell or eval");
});
