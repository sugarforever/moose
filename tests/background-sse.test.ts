import { expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createWorkspaceEnv } from "pi-durable-expo-env/core";
import { MobileEngine } from "../src/runtime/engine";
import { ExecutionOwner } from "../src/runtime/execution-owner";
import { createMobileModels } from "../src/runtime/providers";
import { responseEvents, sseResponse } from "../src/dev/controlled-sse";
import { database, backend } from "./support/workspace";

it("keeps the original SSE, runs a file tool and requests the next round after UI detaches", async () => {
  const root = await mkdtemp(join(tmpdir(), "moose-background-sse-"));
  const path = join(root, "db.sqlite");
  let engine: MobileEngine | undefined;
  let service = false;
  const owner = new ExecutionOwner(
    {
      start: async () => {
        service = true;
      },
      stop: async () => {
        service = false;
      },
    },
    async () => {
      await engine!.stopAll();
    },
  );
  const requests: string[] = [];
  let deliver!: () => void;
  const barrier = new Promise<void>((resolve) => {
    deliver = resolve;
  });
  const calls = [
    {
      name: "write",
      arguments: { path: "result.txt", content: "background tool committed" },
    },
  ];
  const models = createMobileModels(
    async () => "controlled-not-a-real-key",
    (async (_url, init) => {
      expect(service).toBe(true);
      const step = requests.length;
      requests.push(String(init?.body));
      if (step === 0) {
        return new Response(
          new ReadableStream({
            async start(controller) {
              const bytes = new TextEncoder().encode(
                responseEvents(step, calls),
              );
              controller.enqueue(bytes.slice(0, 50));
              await barrier;
              controller.enqueue(bytes.slice(50));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return sseResponse(
        responseEvents(step, calls, "Finished after background tool"),
      );
    }) as typeof fetch,
  );
  const settings = { provider: "openai", modelId: "gpt-4.1-mini" };
  try {
    engine = await MobileEngine.open(
      database(path),
      models,
      settings,
      Date.now,
      (id) => {
        const dir = join(root, id);
        return createWorkspaceEnv({
          backend: {
            ...backend,
            async stat(uri) {
              await mkdir(dir, { recursive: true });
              return backend.stat(uri);
            },
          },
          rootUri: pathToFileURL(dir).href,
        });
      },
      undefined,
      {},
      () => owner.acquire(),
    );
    const chat = await engine.newConversation();
    const detach = await engine.watch(chat.id, () => {});
    const submission = await engine.submit(
      chat.id,
      "Write a file then reply",
      "sse-stable",
    );
    while (requests.length === 0)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await detach(); // Activity/UI teardown has no engine ownership.
    expect(service).toBe(true);
    deliver();
    expect((await submission.wait(engine.context)).status).toBe("done");
    expect(requests.length).toBe(2);
    expect(requests[1]).toContain("background tool committed");
    expect(
      await readFile(join(root, `moose-chat-${chat.id}`, "result.txt"), "utf8"),
    ).toBe("background tool committed");
    await engine.close();
    engine = undefined;
    engine = await MobileEngine.open(database(path), models, settings);
    expect((await engine.messages(chat.id)).at(-1)?.text).toBe(
      "Finished after background tool",
    );
    await (
      await engine.submit(chat.id, "Write a file then reply", "sse-stable")
    ).wait(engine.context);
    expect(requests.length).toBe(2);
  } finally {
    deliver?.();
    await engine?.close();
    await rm(root, { recursive: true, force: true });
  }
});
