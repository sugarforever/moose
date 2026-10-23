import { chatActivity, toolMessages } from "../src/ui/chat-activity";
import type { LiveState } from "@earendil-works/pi-durable";
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
  ).toEqual(["edit", "read", "skill_workspace", "workspace_list", "write"]);
  const observed: string[] = [];
  const detach = await engine.watch(Number(first.id), (view) => {
    observed.push(
      ...chatActivity(view.docs["pi.live"] as unknown as LiveState).map(
        (row) => row.label,
      ),
    );
  });
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
  await detach();
  expect(observed).toContain("write · Running");
  expect(
    toolMessages(await first.context(engine.context)).map(
      (row) => row.activity.label,
    ),
  ).toEqual([
    "write · Completed",
    "edit · Completed",
    "read · Completed",
    "workspace_list · Completed",
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
  expect(
    toolMessages(
      await (await engine.conversation(first.id)).context(engine.context),
    ).map((row) => row.activity.label),
  ).toEqual([
    "write · Completed",
    "edit · Completed",
    "read · Completed",
    "workspace_list · Completed",
  ]);
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

it("advertises bash only for an explicitly selected shell environment", async () => {
  const { root, factory, models, settings } = await fixture();
  const engine = await MobileEngine.open(
    database(join(root, "shell.sqlite")),
    models,
    settings,
    Date.now,
    factory,
    undefined,
    { shell: true },
  );
  cleanup.push(() => engine.close());
  const chat = await engine.newConversation("Termux");
  expect(
    (await chat.agent(engine.context)).tools.map((t) => t.name).sort(),
  ).toEqual(["bash", "edit", "read", "skill_workspace", "write"]);
  expect((await chat.agent(engine.context)).instructions).not.toContain(
    "Shell, script execution",
  );
});

it("uses real Termux bash and file tools together through a controlled model", async () => {
  const { startService } = await import("../components/termux-service/server");
  const { TermuxEnvironment, signedTransport } =
    await import("../src/termux/environment");
  const { ed25519 } = await import("@noble/curves/ed25519.js");
  const { root, models, settings, faux } = await fixture();
  const seed = new Uint8Array(32).fill(4);
  const service = await startService({
    root: join(root, "termux"),
    publicKey: ed25519.getPublicKey(seed),
    port: 0,
  });
  cleanup.push(() => service.close());
  const rpc = signedTransport(service.url, seed, fetch, () =>
    crypto.randomUUID(),
  );
  faux.setResponses([
    call("write", { path: "shared", content: "hello" }),
    call("bash", { command: "cat shared > result; printf shell" }),
    call("read", { path: "result" }),
    fauxAssistantMessage("Done"),
  ]);
  const engine = await MobileEngine.open(
    database(join(root, "termux.sqlite")),
    models,
    settings,
    Date.now,
    (id) => new TermuxEnvironment(id, rpc),
    undefined,
    { shell: true },
  );
  cleanup.push(() => engine.close());
  const chat = await engine.newConversation();
  expect(
    (
      await (
        await engine.submit(chat.id, "Use files and shell", "termux-e2e")
      ).wait(engine.context)
    ).status,
  ).toBe("done");
  expect(
    await fs.readFile(
      join(root, "termux", "workspaces", `moose-chat-${chat.id}`, "result"),
      "utf8",
    ),
  ).toBe("hello");
});

it("copies an enabled Skill bundle into fresh workspace directories with binary files intact", async () => {
  const { root, factory, faux, models, settings } = await fixture();
  const engine = await MobileEngine.open(
    database(join(root, "bundle.sqlite")),
    models,
    settings,
    Date.now,
    factory,
  );
  cleanup.push(() => engine.close());
  const skill = {
    id: "bundle",
    name: "Bundled",
    description: "",
    instructions: "Use files",
    source: "https://example.com/SKILL.md",
    installedAt: 0,
    files: [
      { path: "SKILL.md", size: 9, base64: "VXNlIGZpbGVz" },
      { path: "scripts/run.sh", size: 12, base64: "ZWNobyB3b3JraW5n" },
      { path: "assets/data.bin", size: 3, base64: "AP8B" },
    ],
  };
  await engine.installSkill(skill);
  const chat = await engine.newConversation();
  const run = async (id: string) => {
    faux.setResponses([
      call("skill_workspace", { skillId: "bundle" }),
      fauxAssistantMessage("Done"),
    ]);
    await (await engine.submit(chat.id, "Copy skill", id)).wait(engine.context);
    return (await chat.context(engine.context)).entries
      .flatMap((e) => e.model ?? [])
      .filter((m) => m.role === "toolResult");
  };
  const disabled = await run("disabled");
  expect(disabled.at(-1)).toMatchObject({ isError: true });
  await engine.toggleSkill(chat.id, "bundle");
  const results = await run("enabled");
  const result = results.at(-1)!;
  expect(result.isError).toBeFalsy();
  const text = result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
  const output = JSON.parse(text);
  expect(output.directory).not.toMatch(/^\//);
  expect(
    await fs.readFile(
      join(root, `moose-chat-${chat.id}`, output.directory, "scripts/run.sh"),
      "utf8",
    ),
  ).toBe("echo working");
  expect([
    ...(await fs.readFile(
      join(root, `moose-chat-${chat.id}`, output.directory, "assets/data.bin"),
    )),
  ]).toEqual([0, 255, 1]);
  const again = await run("fresh");
  const secondText = again
    .at(-1)!
    .content.filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
  expect(JSON.parse(secondText).directory).not.toBe(output.directory);
  await engine.uninstallSkill("bundle");
  expect((await run("uninstalled")).at(-1)).toMatchObject({ isError: true });
});

it("executes an installed Skill script with relative references through real Termux transport", async () => {
  const { startService } = await import("../components/termux-service/server");
  const { TermuxEnvironment, signedTransport } =
    await import("../src/termux/environment");
  const { ed25519 } = await import("@noble/curves/ed25519.js");
  const { root, models, settings, faux } = await fixture();
  const seed = new Uint8Array(32).fill(5);
  const service = await startService({
    root: join(root, "termux"),
    publicKey: ed25519.getPublicKey(seed),
    port: 0,
  });
  cleanup.push(() => service.close());
  const rpc = signedTransport(service.url, seed, fetch, () =>
    crypto.randomUUID(),
  );
  const engine = await MobileEngine.open(
    database(join(root, "bundle-shell.sqlite")),
    models,
    settings,
    Date.now,
    (id) => new TermuxEnvironment(id, rpc),
    undefined,
    { shell: true },
  );
  cleanup.push(() => engine.close());
  const script = 'cat "$(dirname "$0")/../references/message.txt"';
  await engine.installSkill({
    id: "shell-bundle",
    name: "Script",
    description: "",
    instructions: "Use script",
    source: "https://example.com/SKILL.md",
    installedAt: 0,
    files: [
      { path: "SKILL.md", base64: "VXNlIHNjcmlwdA==", size: 10 },
      {
        path: "scripts/run.sh",
        base64: Buffer.from(script).toString("base64"),
        size: Buffer.byteLength(script),
      },
      {
        path: "references/message.txt",
        base64: "SGVsbG8gZnJvbSBTa2lsbA==",
        size: 16,
      },
    ],
  });
  const chat = await engine.newConversation();
  await engine.toggleSkill(chat.id, "shell-bundle");
  faux.setResponses([
    call("skill_workspace", { skillId: "shell-bundle" }),
    fauxAssistantMessage("Copied"),
  ]);
  await (
    await engine.submit(chat.id, "Prepare files", "copy")
  ).wait(engine.context);
  const result = (await chat.context(engine.context)).entries
    .flatMap((e) => e.model ?? [])
    .find((m) => m.role === "toolResult" && m.toolName === "skill_workspace");
  expect(result).toMatchObject({ isError: false });
  if (!result || result.role !== "toolResult")
    throw new Error("No copy result");
  const output = JSON.parse(
    result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join(""),
  );
  expect(output.directory).toMatch(/^moose-skill-[a-f0-9]+$/);
  faux.setResponses([
    call("bash", {
      command: `bash ${output.directory}/scripts/run.sh > skill-result.txt`,
    }),
    call("read", { path: "skill-result.txt" }),
    fauxAssistantMessage("Executed"),
  ]);
  await (
    await engine.submit(chat.id, "Run installed script", "execute")
  ).wait(engine.context);
  expect(
    await fs.readFile(
      join(
        root,
        "termux",
        "workspaces",
        `moose-chat-${chat.id}`,
        "skill-result.txt",
      ),
      "utf8",
    ),
  ).toBe("Hello from Skill");
});

it("imports files durably, preserves duplicate filenames and restores attachment bytes into a branch", async () => {
  const { root, factory, faux, models, settings } = await fixture();
  const path = join(root, "attachments.sqlite");
  let engine = await MobileEngine.open(
    database(path),
    models,
    settings,
    Date.now,
    factory,
  );
  cleanup.push(() => engine.close());
  const chat = await engine.newConversation();
  const files = [
    {
      id: "first",
      name: "note.txt",
      mimeType: "text/plain",
      data: "aGk=",
      size: 2,
    },
    {
      id: "second",
      name: "note.txt",
      mimeType: "text/plain",
      data: "Ynll",
      size: 3,
    },
  ];
  faux.setResponses([
    call("read", { path: "/workspace/attachments/first/note.txt" }),
    fauxAssistantMessage("Read hi"),
  ]);
  await (await engine.submit(chat.id, "", "files", files)).wait(engine.context);
  const view = await chat.context(engine.context);
  expect(
    JSON.stringify(
      view.entries
        .flatMap((e) => e.model ?? [])
        .filter((m) => m.role === "toolResult"),
    ),
  ).toContain("hi");
  const checkpoint = await engine.checkpoint(chat.id, "Files");
  await fs.writeFile(
    join(root, `moose-chat-${chat.id}`, "attachments/first/note.txt"),
    "edited",
  );
  await (await engine.submit(chat.id, "", "files", files)).wait(engine.context);
  expect(
    await fs.readFile(
      join(root, `moose-chat-${chat.id}`, "attachments/first/note.txt"),
      "utf8",
    ),
  ).toBe("edited");
  await engine.close();
  engine = await MobileEngine.open(
    database(path),
    models,
    settings,
    Date.now,
    factory,
  );
  expect((await engine.messages(chat.id))[0]).toMatchObject({
    text: "",
    attachments: files,
  });
  const branch = await engine.restoreCheckpoint(checkpoint.id);
  expect(
    await fs.readFile(
      join(root, `moose-chat-${branch.id}`, "attachments/first/note.txt"),
      "utf8",
    ),
  ).toBe("hi");
  expect(
    await fs.readFile(
      join(root, `moose-chat-${branch.id}`, "attachments/second/note.txt"),
      "utf8",
    ),
  ).toBe("bye");
  expect(
    await fs.readFile(
      join(root, `moose-chat-${chat.id}`, "attachments/first/note.txt"),
      "utf8",
    ),
  ).toBe("edited");
});

it("does not import an attachment when its execution lease is already cancelled", async () => {
  const { root, factory, models, settings } = await fixture();
  const controller = new AbortController();
  controller.abort();
  let activeLeases = 0;
  const engine = await MobileEngine.open(
    database(":memory:"),
    models,
    settings,
    Date.now,
    factory,
    undefined,
    {},
    async () => {
      activeLeases++;
      return {
        signal: controller.signal,
        release: async () => {
          activeLeases--;
        },
      };
    },
  );
  cleanup.push(() => engine.close());
  const chat = await engine.newConversation();
  await expect(
    engine.submit(chat.id, "", "cancelled-file", [
      {
        id: "cancelled",
        name: "note.txt",
        mimeType: "text/plain",
        data: "aGk=",
        size: 2,
      },
    ]),
  ).rejects.toThrow("Task stopped");
  await expect(
    fs.stat(
      join(root, `moose-chat-${chat.id}`, "attachments/cancelled/note.txt"),
    ),
  ).rejects.toThrow();
  expect(activeLeases).toBe(0);
  expect(await engine.messages(chat.id)).toEqual([]);
});
