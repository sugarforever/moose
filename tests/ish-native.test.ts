import {
  createEnvConformance,
  createExpectAssertions,
} from "@earendil-works/pi-durable/testing";
import { runFileSmoke } from "../src/dev/files-smoke";
import { DatabaseSync } from "node:sqlite";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { MobileEngine } from "../src/runtime/engine";
import { SerialSqliteDatabase } from "../src/storage/database";
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import {
  createIshWorkspace,
  type IshBridge,
  type IshOutput,
  type IshResult,
  encodeBase64,
  decodeBase64,
} from "../src/runtime/ish";
import { getOrThrow } from "@earendil-works/pi-durable/env";

const core = process.env.MOOSE_ISH_CORE;
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "moose-pi-ish-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const roots = new Set<string>(),
    listeners = new Set<(e: IshOutput) => void>();
  const jobs = new Map<string, ChildProcessWithoutNullStreams>();
  const cancelledIds = new Set<string>();
  let executionTail: Promise<unknown> = Promise.resolve();
  const native: IshBridge = {
    async prepare(id) {
      if (!roots.has(id)) {
        await cp(join(core!, "root"), join(directory, id), { recursive: true });
        roots.add(id);
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    execute(id, command, argv, cwd, env, input, timeout) {
      const pending = executionTail
        .catch(() => {})
        .then(
          () =>
            new Promise<IshResult>((resolve, reject) => {
              if (cancelledIds.has(command)) {
                resolve({
                  exitCode: 137,
                  stdout: "",
                  stderr: "",
                  cancelled: true,
                });
                return;
              }
              const child = spawn(
                join(core!, "moose-ish-exec"),
                [
                  join(directory, id, "data"),
                  cwd,
                  ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
                  "--",
                  ...argv,
                ],
                { env: { NODE_ENV: "test" }, stdio: ["pipe", "pipe", "pipe"] },
              );
              jobs.set(command, child);
              const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
              for (const stream of ["stdout", "stderr"] as const)
                child[stream]!.on("data", (bytes: Buffer) => {
                  output[stream].push(bytes);
                  for (const fn of listeners)
                    fn({
                      commandId: command,
                      stream,
                      data: bytes.toString("base64"),
                    });
                });
              let timedOut = false,
                cancelled = false;
              const timer = setTimeout(() => {
                timedOut = true;
                child.kill("SIGKILL");
              }, timeout);
              child.once("error", reject);
              child.once("close", (code, signal) => {
                clearTimeout(timer);
                jobs.delete(command);
                if (signal && !timedOut && !cancelledIds.has(command)) {
                  reject(new Error(`Embedded core crashed: ${signal}`));
                  return;
                }
                resolve({
                  exitCode: code ?? 137,
                  stdout: Buffer.concat(output.stdout).toString("base64"),
                  stderr: Buffer.concat(output.stderr).toString("base64"),
                  timedOut,
                  cancelled: cancelledIds.has(command),
                });
              });
              child.stdin!.on("error", () => {});
              child.stdin!.end(Buffer.from(decodeBase64(input)));
            }),
        );
      executionTail = pending;
      return pending;
    },
    async cancel(id) {
      cancelledIds.add(id);
      jobs.get(id)?.kill("SIGKILL");
    },
    async cleanup() {
      for (const job of jobs.values()) job.kill("SIGKILL");
    },
  };
  const env = createIshWorkspace("test-1", native);
  cleanups.push(() => env.cleanup(BACKGROUND_CONTEXT));
  return { env, native, directory };
}
describe.skipIf(!core)("Pi adapter on actual embedded iSH", () => {
  it("shares binary files and mutations with real guest shell", async () => {
    const { env } = await fixture();
    getOrThrow(await env.createDir("notes", undefined, BACKGROUND_CONTEXT));
    getOrThrow(
      await env.writeFile("notes/note.txt", "Hello Moose", BACKGROUND_CONTEXT),
    );
    let output = "";
    getOrThrow(
      await env.exec(
        'cat notes/note.txt; printf " updated" >> notes/note.txt',
        {
          onOutput: (t) => {
            output += t;
          },
        },
        BACKGROUND_CONTEXT,
      ),
    );
    expect(output).toBe("Hello Moose");
    expect(
      getOrThrow(await env.readTextFile("notes/note.txt", BACKGROUND_CONTEXT)),
    ).toBe("Hello Moose updated");
    getOrThrow(await env.flushFile("notes/note.txt", BACKGROUND_CONTEXT));
    const bytes = Uint8Array.from([0, 255, 128, 10, 0, 1]);
    getOrThrow(await env.writeFile("binary", bytes, BACKGROUND_CONTEXT));
    expect(
      getOrThrow(await env.readBinaryFile("binary", BACKGROUND_CONTEXT)),
    ).toEqual(bytes);
    expect(
      getOrThrow(await env.listDir("notes", BACKGROUND_CONTEXT)).map(
        (f) => f.name,
      ),
    ).toEqual(["note.txt"]);
  }, 30000);
  it("distinguishes timeout/abort and returns spawn errors for absent programs", async () => {
    const { env } = await fixture();
    const missing = await env.exec(
      ["program-not-installed"],
      undefined,
      BACKGROUND_CONTEXT,
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("spawn_error");
    const result = await env.exec(
      "while :; do :; done",
      { timeout: 0.1 },
      BACKGROUND_CONTEXT,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("timeout");
    const controller = new AbortController();
    const pending = env.exec(
      "sleep 30",
      undefined,
      withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
    );
    setTimeout(() => controller.abort(), 100);
    const aborted = await pending;
    expect(aborted.ok).toBe(false);
    if (!aborted.ok) expect(aborted.error.code).toBe("aborted");
    expect(
      getOrThrow(await env.exec("true", undefined, BACKGROUND_CONTEXT))
        .exitCode,
    ).toBe(0);
  }, 30000);
  it("registers bash only for a shell-capable factory and runs write/bash/read through real Pi Harness", async () => {
    const { native } = await fixture();
    const db = new DatabaseSync(":memory:");
    const storage = new SerialSqliteDatabase({
      execAsync: async (sql) => {
        db.exec(sql);
      },
      runAsync: async (sql, ...args) => {
        db.prepare(sql).run(...args);
      },
      getFirstAsync: async (sql, ...args) =>
        (db.prepare(sql).get(...args) as never) ?? null,
      getAllAsync: async (sql, ...args) =>
        db.prepare(sql).all(...args) as never,
      closeAsync: async () => {
        db.close();
      },
    });
    const faux = fauxProvider(),
      models = createModels();
    models.setProvider(faux.provider);
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
      fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
    faux.setResponses([
      call("write", { path: "note", content: "Hello" }),
      call("bash", { command: 'printf " guest" >> note; cat note' }),
      call("read", { path: "note" }),
      fauxAssistantMessage("Saved"),
    ]);
    const factory = Object.assign(
      (id: string) => createIshWorkspace(id, native),
      { shell: true },
    );
    const engine = await MobileEngine.open(
      storage,
      models,
      { provider: "faux", modelId: "faux-1" },
      Date.now,
      factory,
    );
    cleanups.push(() => engine.close());
    const chat = await engine.newConversation("iSH");
    expect(
      (await chat.agent(engine.context)).tools.map((t) => t.name).sort(),
    ).toEqual(["bash", "edit", "read", "skill_workspace", "write"]);
    const receipt = await (
      await engine.submit(chat.id, "Write and run a guest command", "ish-test")
    ).wait(engine.context);
    expect(receipt.status).toBe("done");
    const view = await chat.context(engine.context);
    const outputs = view.entries
      .flatMap((e) => e.model ?? [])
      .filter((m) => m.role === "toolResult");
    expect(outputs).toHaveLength(3);
    expect(outputs.every((m) => m.role === "toolResult" && !m.isError)).toBe(
      true,
    );
    expect(JSON.stringify(outputs)).toContain("Hello guest");
    expect((await chat.agent(engine.context)).instructions).not.toContain(
      "Shell, script execution",
    );
  }, 30000);

  it("runs controlled OpenAI SSE through generated Pi write/edit/bash/read and reopen", async () => {
    const { native, directory } = await fixture();
    const openDatabase = async () => {
      const db = new DatabaseSync(join(directory, "smoke.sqlite"));
      return new SerialSqliteDatabase({
        execAsync: async (s) => {
          db.exec(s);
        },
        runAsync: async (s, ...p) => {
          db.prepare(s).run(...p);
        },
        getFirstAsync: async (s, ...p) =>
          (db.prepare(s).get(...p) as never) ?? null,
        getAllAsync: async (s, ...p) => db.prepare(s).all(...p) as never,
        closeAsync: async () => {
          db.close();
        },
      });
    };
    const checks = await runFileSmoke(
      openDatabase,
      Object.assign((id: string) => createIshWorkspace(id, native), {
        shell: true,
      }),
    );
    expect(checks).toContain("Moose → OpenAI SSE → Pi write/edit/bash/read");
  }, 30000);

  it("spills shell output above file-tool transfer size into a bounded guest artifact", async () => {
    const { env } = await fixture();
    const result = getOrThrow(
      await env.exec(
        "head -c 9437184 /dev/zero",
        { spill: { afterBytes: 1024, afterLines: 1000 } },
        BACKGROUND_CONTEXT,
      ),
    );
    expect(result.spillPath).toBeTruthy();
    let length = "";
    getOrThrow(
      await env.exec(
        ["/bin/sh", "-c", 'wc -c < "$1"', "size", result.spillPath!],
        {
          onOutput: (t) => {
            length += t;
          },
        },
        BACKGROUND_CONTEXT,
      ),
    );
    expect(Number(length.trim())).toBe(9437184);
  }, 30000);

  for (const test of createEnvConformance({
    assertions: createExpectAssertions(expect),
    shell: ["/bin/sh", "-c"],
    withEnv: async (use) => {
      const { env } = await fixture();
      await use(env);
    },
  }))
    it(test.name, test.run, test.timeoutMs ?? 30000);
});
