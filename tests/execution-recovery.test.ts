import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MobileEngine } from "../src/runtime/engine";
import {
  ExecutionDoc,
  executionStatus,
  hasUnknownEffect,
} from "../src/runtime/execution-diagnostics";
import { createMobileModels } from "../src/runtime/providers";
import { responseEvents, sseResponse } from "../src/dev/controlled-sse";
import { database } from "./support/workspace";
const settings = { provider: "openai", modelId: "gpt-4.1-mini" };

it("commits network failure, retries in the same submission and shows recovered history after SQLite reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "moose-diagnostic-"));
  const path = join(root, "db.sqlite");
  let requests = 0;
  const models = createMobileModels(async () => "controlled", (async () => {
    requests++;
    if (requests === 1)
      return sseResponse(
        'data: {"type":"response.failed","response":{"id":"controlled","error":{"code":"server_error","message":"network error"}}}\n\n',
      );
    return sseResponse(responseEvents(1, [], "Recovered answer"));
  }) as typeof fetch);
  let engine = await MobileEngine.open(database(path), models, settings);
  try {
    const chat = await engine.newConversation();
    const sub = await engine.submit(chat.id, "analyze", "one-stable-id");
    expect((await sub.wait(engine.context)).status).toBe("done");
    expect(requests).toBe(2);
    const messages = await engine.messages(chat.id);
    expect(messages.find((m) => m.failure)?.failure).toMatchObject({
      recovered: true,
      retries: 0,
      phase: "generation",
    });
    const doc = await engine.harness.snapshot(
      ExecutionDoc,
      chat.id,
      engine.context,
    );
    expect(
      doc?.events.filter((e) => e.kind === "response").map((e) => e.attempt),
    ).toEqual([1, 2]);
    await engine.close();
    engine = await MobileEngine.open(database(path), models, settings);
    const view = await engine.view(chat.id);
    expect(executionStatus(view)).toMatchObject({
      state: "completed",
      retries: 1,
    });
    expect(
      (await engine.messages(chat.id)).find((m) => m.failure)?.failure
        ?.recovered,
    ).toBe(true);
    await (
      await engine.submit(chat.id, "analyze", "one-stable-id")
    ).wait(engine.context);
    expect(requests).toBe(2);
  } finally {
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

it("persists native cancellation detail before abort and never retries a stopped backoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "moose-cancel-"));
  let requests = 0;
  const models = createMobileModels(async () => "controlled", (async () => {
    requests++;
    return sseResponse(
      'data: {"type":"response.failed","response":{"id":"controlled","error":{"code":"server_error","message":"network error"}}}\n\n',
    );
  }) as typeof fetch);
  const engine = await MobileEngine.open(
    database(join(root, "db.sqlite")),
    models,
    settings,
  );
  try {
    const chat = await engine.newConversation();
    const sub = await engine.submit(chat.id, "analyze", "stop-id");
    await new Promise<void>(async (resolve, reject) => {
      let detach: (() => Promise<unknown>) | undefined;
      const timeout = setTimeout(
        () => reject(new Error("retry did not start")),
        3000,
      );
      detach = await engine.watch(chat.id, (view) => {
        if (
          ["retrying", "waiting_network"].includes(executionStatus(view).state)
        ) {
          clearTimeout(timeout);
          void detach?.();
          resolve();
        }
      });
    });
    await engine.stopAll({ reason: "budget_expired", at: Date.now() });
    expect((await sub.wait(engine.context)).status).not.toBe("done");
    const view = await engine.view(chat.id);
    expect(executionStatus(view)).toMatchObject({
      state: "cancelled",
      reason: "budget_expired",
    });
    expect(requests).toBe(1);
  } finally {
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("clears a completed durable outbox without submitting the task again", async () => {
  const root = await mkdtemp(join(tmpdir(), "moose-outbox-"));
  let requests = 0;
  const models = createMobileModels(async () => "controlled", (async () => {
    requests++;
    return sseResponse(responseEvents(1, [], "done"));
  }) as typeof fetch);
  const engine = await MobileEngine.open(
    database(join(root, "db.sqlite")),
    models,
    settings,
  );
  try {
    const chat = await engine.newConversation();
    const pending = {
      conversationId: chat.id,
      requestId: "outbox-id",
      text: "do work",
    };
    await engine.write(`outbox:${chat.id}`, pending);
    await (
      await engine.submit(chat.id, pending.text, pending.requestId)
    ).wait(engine.context);
    expect(await engine.pendingRequest(chat.id)).toBeNull();
    expect(await engine.read(`outbox:${chat.id}`, pending)).toBeNull();
    expect(requests).toBe(1);
  } finally {
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("does not repeat an unknown write, including a fresh model call after runtime restart", async () => {
  const { createWorkspaceEnv } = await import("pi-durable-expo-env/core");
  const { backend } = await import("./support/workspace");
  const { pathToFileURL } = await import("node:url");
  const { mkdir, readFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "moose-unknown-"));
  const dbPath = join(root, "db.sqlite");
  const dir = join(root, "files");
  await mkdir(dir);
  let writes = 0;
  let requests = 0;
  let wrote!: () => void;
  const written = new Promise<void>((resolve) => {
    wrote = resolve;
  });
  const models = createMobileModels(async () => "controlled", (async () => {
    const step = requests++;
    if (step === 4 || step === 6 || step === 8)
      return sseResponse(
        responseEvents(0, [
          {
            name: "write",
            arguments: { path: "once.txt", content: "authorized" },
          },
        ]),
      );
    return sseResponse(
      responseEvents(
        step,
        [
          { name: "write", arguments: { path: "once.txt", content: "once" } },
          {
            name: "write",
            arguments: { path: "once.txt", content: "duplicate" },
          },
        ],
        step === 2 ? "x".repeat(100000) : "Summary / final answer",
      ),
    );
  }) as typeof fetch);
  let initial = true;
  const factory = () => {
    const env = createWorkspaceEnv({
      rootUri: pathToFileURL(dir).href,
      backend: {
        ...backend,
        async write(uri, data) {
          writes++;
          await backend.write(uri, data);
        },
      },
    });
    const original = env.writeFile.bind(env);
    env.writeFile = async (path, content, context) => {
      const result = await original(path, content, context);
      if (initial) {
        wrote();
        await new Promise<void>((_resolve, reject) => {
          const signal = context.abortSignal!;
          if (signal.aborted) reject(new Error("closed"));
          else
            signal.addEventListener(
              "abort",
              () => reject(new Error("closed")),
              { once: true },
            );
        });
      }
      return result;
    };
    return env;
  };
  let engine = await MobileEngine.open(
    database(dbPath),
    models,
    settings,
    Date.now,
    factory,
  );
  try {
    const chat = await engine.newConversation();
    await engine.submit(chat.id, "write once", "unknown-stable");
    await written;
    await engine.close();
    initial = false;
    engine = await MobileEngine.open(
      database(dbPath),
      models,
      settings,
      Date.now,
      factory,
    );
    await engine.resume();
    await engine.harness.waitForIdle(engine.context);
    expect(writes).toBe(1);
    expect(await readFile(join(dir, "once.txt"), "utf8")).toBe("once");
    expect(requests).toBe(3);
    const view = await engine.view(chat.id);
    expect(JSON.stringify(view.entries)).toContain("may have partially run");
    expect(JSON.stringify(view.entries)).toContain("unknown outcome");
    expect(
      view.entries
        .flatMap((entry) => entry.model ?? [])
        .filter((m) => m.role === "user"),
    ).toHaveLength(1);
    expect(executionStatus(view)).toMatchObject({
      state: "waiting_authorization",
      unknownEffects: true,
    });
    const compact = await (
      await engine.conversation(chat.id)
    ).compact(undefined, engine.context);
    const outcome = await engine.harness.waitForTask(compact, engine.context);
    expect(outcome.state.outcome.status).toBe("completed");
    const compacted = await (
      await engine.conversation(chat.id)
    ).context(engine.context);
    expect(compacted.head).toBeDefined();
    expect(hasUnknownEffect(compacted.messages)).toBe(false);
    await (
      await engine.submit(
        chat.id,
        "continue after compaction",
        "after-compaction",
      )
    ).wait(engine.context);
    expect(writes).toBe(1);
    await engine.acknowledgeUnknownEffects(chat.id);
    await (
      await engine.submit(
        chat.id,
        "I inspected the file; write again",
        "after-review",
      )
    ).wait(engine.context);
    expect(writes).toBe(2);
    expect(await readFile(join(dir, "once.txt"), "utf8")).toBe("authorized");
    initial = true;
    const cancelled = await engine.submit(
      chat.id,
      "write then stop",
      "cancel-mutation",
    );
    for (let spin = 0; writes < 3 && spin < 100; spin++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(writes).toBe(3);
    await engine.stopConversation(chat.id);
    expect((await cancelled.wait(engine.context)).status).not.toBe("done");
    expect(
      (await engine.harness.snapshot(ExecutionDoc, chat.id, engine.context))
        ?.unknown,
    ).toBe(true);
    expect(executionStatus(await engine.view(chat.id))).toMatchObject({
      state: "cancelled",
      unknownEffects: true,
    });
  } finally {
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("recovers a committed partial after runtime loss without adding a second user input", async () => {
  const root = await mkdtemp(join(tmpdir(), "moose-partial-"));
  const path = join(root, "db.sqlite");
  let requests = 0;
  const models = createMobileModels(async () => "controlled", (async (
    _url,
    init,
  ) => {
    if (++requests > 1)
      return sseResponse(responseEvents(1, [], "Recovered partial"));
    const events = responseEvents(1, [], "Committed partial");
    const cut = events.indexOf('data: {"type":"response.output_text.done"');
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(events.slice(0, cut)));
          init?.signal?.addEventListener(
            "abort",
            () => controller.error(new Error("closed")),
            { once: true },
          );
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch);
  let engine = await MobileEngine.open(database(path), models, settings);
  try {
    const chat = await engine.newConversation();
    await engine.submit(chat.id, "one input", "partial-stable");
    await new Promise<void>(async (resolve, reject) => {
      let detach: (() => Promise<unknown>) | undefined;
      const timer = setTimeout(
        () => reject(new Error("no committed partial")),
        2000,
      );
      detach = await engine.watch(chat.id, (view) => {
        if (
          JSON.stringify(view.docs["pi.live"]).includes("Committed partial")
        ) {
          clearTimeout(timer);
          void detach?.();
          resolve();
        }
      });
    });
    await engine.close();
    engine = await MobileEngine.open(database(path), models, settings);
    await engine.resume();
    await engine.harness.waitForIdle(engine.context);
    const view = await engine.view(chat.id);
    const messages = await engine.messages(chat.id);
    expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(messages.find((m) => m.failure)?.failure).toMatchObject({
      reason: "runtime_restart",
      recovered: true,
    });
    expect(executionStatus(view).state).toBe("completed");
    expect(requests).toBe(2);
  } finally {
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("bounds transient generation retries and does not retry authentication failures", async () => {
  for (const [error, expected] of [
    ["network error", 4],
    ["401 unauthorized", 1],
  ] as const) {
    let requests = 0;
    const models = createMobileModels(async () => "controlled", (async () => {
      requests++;
      return sseResponse(
        `data: ${JSON.stringify({ type: "response.failed", response: { id: "controlled", error: { code: "controlled", message: error } } })}\n\n`,
      );
    }) as typeof fetch);
    const engine = await MobileEngine.open(
      database(":memory:"),
      models,
      settings,
    );
    try {
      const chat = await engine.newConversation();
      const sub = await engine.submit(chat.id, "one input", "bounded");
      expect((await sub.wait(engine.context)).status).not.toBe("done");
      expect(requests).toBe(expected);
      expect(executionStatus(await engine.view(chat.id)).state).toBe(
        expected === 1 ? "waiting_authorization" : "failed",
      );
    } finally {
      await engine.close();
    }
  }
}, 25000);

it("shows a durable scheduler fault when a provider adapter throws before returning a message", async () => {
  const base = createMobileModels(async () => "controlled", (async () => {
    throw new Error("must not fetch");
  }) as typeof fetch);
  const models = new Proxy(base, {
    get(target, key, receiver) {
      return key === "streamSimple"
        ? () => {
            throw new Error("provider adapter crashed");
          }
        : Reflect.get(target, key, receiver);
    },
  });
  const engine = await MobileEngine.open(
    database(":memory:"),
    models,
    settings,
  );
  try {
    const chat = await engine.newConversation();
    const sub = await engine.submit(chat.id, "one input", "faulted");
    expect((await sub.wait(engine.context)).status).not.toBe("done");
    expect(executionStatus(await engine.view(chat.id))).toMatchObject({
      state: "failed",
      reason: "provider adapter crashed",
    });
  } finally {
    await engine.close();
  }
});

it("keeps HTTP retries visible in the durable generation budget", async () => {
  let requests = 0;
  const models = createMobileModels(async () => "controlled", (async () => {
    if (++requests === 1)
      return new Response(
        JSON.stringify({
          error: { message: "temporarily unavailable", type: "server_error" },
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    return sseResponse(responseEvents(1, [], "Recovered HTTP"));
  }) as typeof fetch);
  const engine = await MobileEngine.open(
    database(":memory:"),
    models,
    settings,
  );
  try {
    const chat = await engine.newConversation();
    expect(
      (
        await (
          await engine.submit(chat.id, "one input", "http-retry")
        ).wait(engine.context)
      ).status,
    ).toBe("done");
    expect(requests).toBe(2);
    expect(executionStatus(await engine.view(chat.id))).toMatchObject({
      state: "completed",
      retries: 1,
    });
    expect(
      (await engine.messages(chat.id)).some((m) => m.failure?.recovered),
    ).toBe(true);
  } finally {
    await engine.close();
  }
});

it("does not acknowledge a newer unknown operation committed during the review action", async () => {
  const models = createMobileModels(async () => "controlled", (async () =>
    sseResponse(responseEvents(1, [], "done"))) as typeof fetch);
  const engine = await MobileEngine.open(
    database(":memory:"),
    models,
    settings,
  );
  try {
    const chat = await engine.newConversation();
    await (
      await engine.submit(chat.id, "one input", "review-race")
    ).wait(engine.context);
    const original = engine.view.bind(engine);
    engine.view = async (id) => {
      const view = await original(id);
      await engine.harness.commit(async (tx) => {
        const doc = await tx.doc(ExecutionDoc, chat.id);
        doc.unknown = true;
        doc.unknownThrough =
          Math.max(...view.entries.map((entry) => Number(entry.id))) + 1;
      }, engine.context);
      return view;
    };
    await engine.acknowledgeUnknownEffects(chat.id);
    expect(
      (await engine.harness.snapshot(ExecutionDoc, chat.id, engine.context))
        ?.unknown,
    ).toBe(true);
  } finally {
    await engine.close();
  }
});

it("retries Android's stream-level connection abort while retaining its original error text", async () => {
  let requests = 0;
  const models = createMobileModels(async () => "controlled", (async () => {
    if (++requests > 1)
      return sseResponse(responseEvents(1, [], "Recovered Android stream"));
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(responseEvents(1, []).slice(0, 50)),
          );
          controller.error(new Error("Software caused connection abort"));
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch);
  const engine = await MobileEngine.open(
    database(":memory:"),
    models,
    settings,
  );
  try {
    const chat = await engine.newConversation();
    const receipt = await (
      await engine.submit(chat.id, "one input", "android-network")
    ).wait(engine.context);
    expect(receipt.status).toBe("done");
    expect(requests).toBe(2);
    expect(
      (await engine.messages(chat.id)).find((m) => m.failure)?.failure,
    ).toMatchObject({
      recovered: true,
      message: expect.stringContaining("Software caused connection abort"),
    });
  } finally {
    await engine.close();
  }
});
