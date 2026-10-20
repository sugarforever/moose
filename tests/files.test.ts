import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import {
  createWorkspaceEnv,
  type WorkspaceBackend,
} from "pi-durable-expo-env/core";
import { runFileSmoke } from "../src/dev/files-smoke";
import { MobileEngine } from "../src/runtime/engine";
import {
  SerialSqliteDatabase,
  type NativeSqlite,
} from "../src/storage/database";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
function database(path: string) {
  const db = new DatabaseSync(path);
  return new SerialSqliteDatabase({
    execAsync: async (sql) => {
      db.exec(sql);
    },
    runAsync: async (sql, ...args) => {
      db.prepare(sql).run(...args);
    },
    getFirstAsync: async (sql, ...args) =>
      (db.prepare(sql).get(...args) as never) ?? null,
    getAllAsync: async (sql, ...args) => db.prepare(sql).all(...args) as never,
    closeAsync: async () => db.close(),
  } satisfies NativeSqlite);
}
const backend: WorkspaceBackend = {
  async stat(uri) {
    try {
      const s = await fs.stat(fileURLToPath(uri));
      return {
        kind: s.isDirectory() ? "directory" : "file",
        size: s.size,
        mtimeMs: s.mtimeMs,
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  },
  async read(uri, limit, signal) {
    signal.throwIfAborted();
    const h = await fs.open(fileURLToPath(uri), "r");
    try {
      const data = new Uint8Array(limit + 1);
      const { bytesRead } = await h.read(data);
      if (bytesRead > limit) throw new Error("Size limit");
      return data.slice(0, bytesRead);
    } finally {
      await h.close();
    }
  },
  async write(uri, data) {
    await fs.writeFile(fileURLToPath(uri), data);
  },
  async mkdir(uri, recursive) {
    await fs.mkdir(fileURLToPath(uri), { recursive });
  },
  async names(uri) {
    return fs.readdir(fileURLToPath(uri));
  },
  async remove(uri, recursive) {
    await fs.rm(fileURLToPath(uri), { recursive });
  },
  async move(a, b) {
    await fs.rename(fileURLToPath(a), fileURLToPath(b));
  },
};
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "moose-files-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const environments: ReturnType<typeof createWorkspaceEnv>[] = [];
  const factory = (workspaceId: string) => {
    const dir = join(root, workspaceId);
    const env = createWorkspaceEnv({
      backend: {
        ...backend,
        async stat(uri) {
          await fs.mkdir(dir, { recursive: true });
          return backend.stat(uri);
        },
      },
      rootUri: pathToFileURL(dir).href,
    });
    environments.push(env);
    return env;
  };
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const settings = { provider: "faux", modelId: "faux-1" };
  return { root, factory, environments, faux, models, settings };
}
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
it("runs genuine tools through Moose, persists files, isolates conversations and closes environments", async () => {
  const { root, factory, environments, faux, models, settings } =
    await fixture();
  faux.setResponses([
    call("write", { path: "notes/test.txt", content: "Hello Expo" }),
    call("edit", {
      path: "notes/test.txt",
      edits: [{ oldText: "Hello", newText: "你好" }],
    }),
    call("read", { path: "notes/test.txt" }),
    call("workspace_list", { path: "notes" }),
    fauxAssistantMessage("Saved"),
  ]);
  let engine = await MobileEngine.open(
    database(join(root, "session.sqlite")),
    models,
    settings,
    Date.now,
    factory,
  );
  cleanup.push(() => engine.close());
  const first = await engine.newConversation("Files");
  expect(
    (await first.agent(engine.context)).tools.map((t) => t.name).sort(),
  ).toEqual(["edit", "read", "workspace_list", "write"]);
  expect(
    (
      await (
        await engine.submit(
          first.id,
          "Write, edit and read a note",
          "file-tools",
        )
      ).wait(engine.context)
    ).status,
  ).toBe("done");
  expect(
    await fs.readFile(
      join(root, `moose-chat-${first.id}`, "notes/test.txt"),
      "utf8",
    ),
  ).toBe("你好 Expo");
  expect((await engine.messages(first.id)).map((m) => m.text)).toEqual([
    "Write, edit and read a note",
    "Saved",
  ]);
  const checkpoint = await engine.checkpoint(first.id, "File checkpoint");
  const branch = await engine.restoreCheckpoint(checkpoint.id);
  const second = await engine.newConversation("Other");
  for (const isolated of [second, branch]) {
    faux.setResponses([
      call("read", { path: "notes/test.txt" }),
      fauxAssistantMessage("No file"),
    ]);
    await (
      await engine.submit(
        isolated.id,
        "Read the note",
        `isolated-${isolated.id}`,
      )
    ).wait(engine.context);
    const view = await isolated.context(engine.context);
    expect(
      view.entries
        .flatMap((entry) => entry.model ?? [])
        .some((message) => message.role === "toolResult" && message.isError),
    ).toBe(true);
  }
  expect(
    JSON.stringify((await first.context(engine.context)).entries),
  ).toContain("conversation-private");
  expect(environments).toHaveLength(3);
  await first.configure(
    {
      instructions:
        "You are Moose, a helpful mobile assistant. Reply in the user’s language. Skills provide instructions only. No shell, scripts, filesystem tools or external skill resources are available. Never claim to have executed them.\n<skill>Keep this instruction</skill>",
    },
    engine.context,
  );
  const old = environments[0];
  await engine.close();
  expect((await old.exists(".", engine.context)).ok).toBe(false);
  engine = await MobileEngine.open(
    database(join(root, "session.sqlite")),
    models,
    settings,
    Date.now,
    factory,
  );
  const upgraded = await (
    await engine.conversation(first.id)
  ).agent(engine.context);
  expect(upgraded.instructions).not.toContain(
    "No shell, scripts, filesystem tools",
  );
  expect(upgraded.instructions).toContain(
    "<skill>Keep this instruction</skill>",
  );
  faux.setResponses([
    call("read", { path: "notes/test.txt" }),
    fauxAssistantMessage("Still here"),
  ]);
  expect(
    (
      await (
        await engine.submit(first.id, "Read the note", "read-again")
      ).wait(engine.context)
    ).status,
  ).toBe("done");
  const view = await (
    await engine.conversation(first.id)
  ).context(engine.context);
  expect(JSON.stringify(view.entries)).toContain("你好 Expo");
});
it("returns a tool error for traversal without writing outside the workspace", async () => {
  const { root, factory, faux, models, settings } = await fixture();
  faux.setResponses([
    call("write", { path: "../outside.txt", content: "no" }),
    fauxAssistantMessage("Blocked"),
  ]);
  const engine = await MobileEngine.open(
    database(":memory:"),
    models,
    settings,
    Date.now,
    factory,
  );
  cleanup.push(() => engine.close());
  const chat = await engine.newConversation();
  await (
    await engine.submit(chat.id, "Attempt escape", "escape")
  ).wait(engine.context);
  await expect(fs.stat(join(root, "outside.txt"))).rejects.toThrow();
  const view = await chat.context(engine.context);
  expect(JSON.stringify(view.entries)).toContain("Path escapes workspace");
});

it("passes the native smoke fixture through the generated runtime and controlled OpenAI SSE", async () => {
  const { root, factory } = await fixture();
  const checks = await runFileSmoke(
    async () => database(join(root, "native-smoke.sqlite")),
    factory,
  );
  expect(checks).toHaveLength(8);
});

it("upgrades a restored historical checkpoint while preserving its Skill instructions", async () => {
  const { root, factory, faux, models, settings } = await fixture();
  const path = join(root, "historical.sqlite");
  let engine = await MobileEngine.open(database(path), models, settings);
  cleanup.push(() => engine.close());
  const chat = await engine.newConversation();
  const legacy =
    "You are Moose, a helpful mobile assistant. Reply in the user’s language. Skills provide instructions only. No shell, scripts, filesystem tools or external skill resources are available. Never claim to have executed them.";
  await chat.configure(
    { instructions: legacy + "\n<skill>Historical instructions</skill>" },
    engine.context,
  );
  faux.setResponses([fauxAssistantMessage("Old answer")]);
  await (
    await engine.submit(chat.id, "Before upgrade", "old")
  ).wait(engine.context);
  const checkpoint = await engine.checkpoint(chat.id, "Before upgrade");
  await engine.close();
  engine = await MobileEngine.open(
    database(path),
    models,
    settings,
    Date.now,
    factory,
  );
  const branch = await engine.restoreCheckpoint(checkpoint.id);
  const instructions = (await branch.agent(engine.context)).instructions;
  expect(instructions).not.toContain("No shell, scripts, filesystem tools");
  expect(instructions).toContain("<skill>Historical instructions</skill>");
});

it("rejects a checkpoint while a text-bearing tool call is still running", async () => {
  const { factory, faux, models, settings } = await fixture();
  let enter!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocked = (id: string) => {
    const env = factory(id),
      write = env.writeFile.bind(env);
    env.writeFile = async (...args) => {
      enter();
      await gate;
      return write(...args);
    };
    return env;
  };
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxText("Writing a note"),
        fauxToolCall("write", { path: "note.txt", content: "done" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done"),
  ]);
  const engine = await MobileEngine.open(
    database(":memory:"),
    models,
    settings,
    Date.now,
    blocked,
  );
  cleanup.push(() => engine.close());
  const chat = await engine.newConversation();
  const submission = await engine.submit(chat.id, "Write a note", "writing");
  await started;
  try {
    await expect(engine.checkpoint(chat.id, "Too early")).rejects.toThrow(
      "Wait for a completed answer",
    );
  } finally {
    release();
  }
  await submission.wait(engine.context);
  expect(
    (await engine.checkpoint(chat.id, "Completed")).entryId,
  ).toBeGreaterThan(0);
});
