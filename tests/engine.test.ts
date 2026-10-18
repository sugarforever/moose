import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import {
  SerialSqliteDatabase,
  type NativeSqlite,
} from "../src/storage/database";
import { MobileEngine } from "../src/runtime/engine";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
function database(path: string) {
  const db = new DatabaseSync(path);
  return new SerialSqliteDatabase({
    execAsync: async (sql) => {
      db.exec(sql);
    },
    runAsync: async (sql, ...params) => {
      db.prepare(sql).run(...params);
    },
    getFirstAsync: async (sql, ...params) =>
      (db.prepare(sql).get(...params) as never) ?? null,
    getAllAsync: async (sql, ...params) =>
      db.prepare(sql).all(...params) as never,
    closeAsync: async () => db.close(),
  } satisfies NativeSqlite);
}
function fixture() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models, settings: { provider: "faux", modelId: "faux-1" } };
}
async function until(predicate: () => Promise<boolean>) {
  for (let i = 0; i < 300; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Expected durable state was never committed");
}

it("reopens committed conversations, retries without duplicate input, and forks a saved checkpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "moose-test-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const { faux, models, settings } = fixture();
  faux.setResponses([
    fauxAssistantMessage("First answer"),
    fauxAssistantMessage("Second answer"),
  ]);
  let engine = await MobileEngine.open(
    database(join(dir, "session.sqlite")),
    models,
    settings,
  );
  const conversation = await engine.newConversation("Test chat");
  await (
    await engine.submit(conversation.id, "Hello", "stable-request")
  ).wait(engine.context);
  const checkpoint = await engine.checkpoint(
    conversation.id,
    "Before second question",
  );
  await (
    await engine.submit(conversation.id, "Next", "next-request")
  ).wait(engine.context);
  await engine.close();
  engine = await MobileEngine.open(
    database(join(dir, "session.sqlite")),
    models,
    settings,
  );
  cleanup.push(() => engine.close());
  await (
    await engine.submit(conversation.id, "Hello", "stable-request")
  ).wait(engine.context);
  expect(
    (await engine.messages(conversation.id))
      .filter((m) => m.role === "user")
      .map((m) => m.text),
  ).toEqual(["Hello", "Next"]);
  const branch = await engine.restoreCheckpoint(checkpoint.id);
  expect((await engine.messages(branch.id)).map((m) => m.text)).toEqual([
    "Hello",
    "First answer",
  ]);
  expect((await engine.listConversations()).length).toBe(2);
  expect(faux.state.callCount).toBe(2);
});

it("recovers a repeat checkpoint after close, executes once when overdue, and finishes its run count", async () => {
  const dir = await mkdtemp(join(tmpdir(), "moose-repeat-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const { faux, models, settings } = fixture();
  faux.setResponses([
    fauxAssistantMessage("Run one"),
    fauxAssistantMessage("Run two"),
  ]);
  let now = Date.now();
  let engine = await MobileEngine.open(
    database(join(dir, "session.sqlite")),
    models,
    settings,
    () => now,
  );
  const conversation = await engine.newConversation("Repeat");
  const id = await engine.repeat(conversation.id, "Daily summary", 60000, 2);
  await until(async () => (await engine.repeatStatus(id)).completed === 1);
  await engine.close();
  now += 600000;
  engine = await MobileEngine.open(
    database(join(dir, "session.sqlite")),
    models,
    settings,
    () => now,
  );
  cleanup.push(() => engine.close());
  engine.resume();
  await until(
    async () => (await engine.repeatStatus(id)).status === "terminal",
  );
  expect(
    (await engine.messages(conversation.id)).filter((m) => m.role === "user"),
  ).toHaveLength(2);
  expect(faux.state.callCount).toBe(2);
  expect((await engine.repeatStatus(id)).completed).toBe(2);
});

it("preserves completed repeat progress when remaining repetitions are stopped", async () => {
  const { faux, models, settings } = fixture();
  faux.setResponses([fauxAssistantMessage("Finished first run")]);
  const engine = await MobileEngine.open(
    database(":memory:"),
    models,
    settings,
  );
  cleanup.push(() => engine.close());
  const conversation = await engine.newConversation();
  const id = await engine.repeat(conversation.id, "One step", 60000, 3);
  await until(async () => (await engine.repeatStatus(id)).completed === 1);
  await engine.stopTask(id);
  await until(
    async () => (await engine.repeatStatus(id)).status === "terminal",
  );
  expect((await engine.repeatStatus(id)).completed).toBe(1);
  expect((await engine.repeatStatus(id)).outcome).toBe("aborted");
});

it("serializes rapid skill toggles and removes installed instructions from every conversation", async () => {
  const { models, settings } = fixture();
  const engine = await MobileEngine.open(
    database(":memory:"),
    models,
    settings,
  );
  cleanup.push(() => engine.close());
  const first = await engine.newConversation();
  const second = await engine.newConversation();
  for (const name of ["alpha", "beta"])
    await engine.installSkill({
      id: name,
      name,
      description: name,
      instructions: `Use ${name} instructions`,
      source: `https://example.com/${name}/SKILL.md`,
      installedAt: 0,
    });
  await Promise.all([
    engine.toggleSkill(first.id, "alpha"),
    engine.toggleSkill(first.id, "beta"),
  ]);
  expect(await engine.read(`skills:${first.id}`, [])).toEqual([
    "alpha",
    "beta",
  ]);
  await engine.toggleSkill(second.id, "alpha");
  expect((await first.agent(engine.context)).instructions).toContain(
    "Use alpha instructions",
  );
  await engine.uninstallSkill("alpha");
  expect(await engine.read(`skills:${first.id}`, [])).toEqual(["beta"]);
  expect(await engine.read(`skills:${second.id}`, [])).toEqual([]);
  expect((await first.agent(engine.context)).instructions).not.toContain(
    "Use alpha instructions",
  );
  expect((await second.agent(engine.context)).instructions).not.toContain(
    "Use alpha instructions",
  );
});
