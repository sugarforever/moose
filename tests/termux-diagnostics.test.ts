import { expect, it, vi } from "vitest";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { FileError } from "@earendil-works/pi-durable/env";
import { signedTransport } from "../src/termux/environment";
import { TermuxDiagnostics } from "../src/termux/diagnostics";
import { encode } from "../src/termux/wire";
const seed = new Uint8Array(32).fill(3);
const url = "http://127.0.0.1:18765/";
const pending: typeof fetch = async (_url, init) =>
  new Promise((_resolve, reject) => {
    init!.signal!.addEventListener(
      "abort",
      () => reject(new Error("Fetch request has been canceled")),
      { once: true },
    );
  });
it("distinguishes the RPC deadline from caller cancellation and does not send already cancelled calls", async () => {
  vi.useFakeTimers();
  try {
    const diagnostics = new TermuxDiagnostics();
    const fetcher = vi.fn(pending);
    const rpc = signedTransport(
      url,
      seed,
      fetcher as typeof fetch,
      () => "id",
      diagnostics.record,
    );
    const failure = expect(
      rpc("test", "/workspace", "readTextFile", ["secret"], BACKGROUND_CONTEXT),
    ).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(15001);
    await failure;
    expect(diagnostics.snapshot().connection).toBe("unavailable");
    const abort = new AbortController();
    const cancelled = expect(
      rpc(
        "test",
        "/workspace",
        "readTextFile",
        [],
        withAbortSignal(abort.signal, BACKGROUND_CONTEXT),
      ),
    ).rejects.toMatchObject({ kind: "cancelled" });
    abort.abort();
    await cancelled;
    const calls = fetcher.mock.calls.length;
    await expect(
      rpc(
        "test",
        "/workspace",
        "writeFile",
        [],
        withAbortSignal(abort.signal, BACKGROUND_CONTEXT),
      ),
    ).rejects.toMatchObject({ kind: "cancelled" });
    expect(fetcher).toHaveBeenCalledTimes(calls);
  } finally {
    vi.useRealTimers();
  }
});
it("does not mislabel native fetch cancellation without caller abort as user cancellation", async () => {
  const rpc = signedTransport(
    url,
    seed,
    async () => {
      throw new Error("Fetch request has been canceled");
    },
    () => "id",
  );
  await expect(
    rpc("test", "/workspace", "connect", [], BACKGROUND_CONTEXT),
  ).rejects.toMatchObject({ kind: "network" });
});
it("keeps signed file errors separate from connectivity and excludes content from diagnostic export", async () => {
  const d = new TermuxDiagnostics();
  const response = {
    ok: false,
    error: new FileError(
      "not_found",
      "private hello.txt token",
      "/private/path",
    ),
  };
  const rpc = signedTransport(
    url,
    seed,
    async () => new Response(JSON.stringify(encode(response))),
    () => "secret-id",
    d.record,
  );
  expect(
    await rpc(
      "private-workspace",
      "/private",
      "readTextFile",
      ["private"],
      BACKGROUND_CONTEXT,
    ),
  ).toMatchObject({ ok: false, error: { code: "not_found" } });
  expect(d.snapshot().connection).toBe("available");
  expect(d.export()).toContain("file_error");
  expect(d.export()).not.toMatch(/private|secret|hello|token/);
});
it.each([
  [async () => new Response("{}", { status: 401 }), "rejected"],
  [async () => new Response("not json"), "protocol"],
  [
    async () =>
      new Response(JSON.stringify({ transportError: "private service error" })),
    "service",
  ],
  [async () => new Response("{}"), "protocol"],
] as const)(
  "classifies invalid service responses without retaining raw messages",
  async (fetcher, kind) => {
    const d = new TermuxDiagnostics();
    const rpc = signedTransport(url, seed, fetcher, () => "id", d.record);
    await expect(
      rpc("test", "/workspace", "connect", [], BACKGROUND_CONTEXT),
    ).rejects.toMatchObject({ kind });
    expect(d.export()).not.toContain("private");
  },
);
it("bounds diagnostics and does not change reachability for cancellation", () => {
  const d = new TermuxDiagnostics();
  d.record({ op: "connect", result: "ok", elapsedMs: 1 });
  for (let i = 0; i < 50; i++)
    d.record({ op: "poll", result: "cancelled", elapsedMs: 2 });
  expect(d.snapshot().connection).toBe("available");
  expect(d.snapshot().records).toHaveLength(40);
  d.record({ op: "sensitive contents", result: "network", elapsedMs: 1 });
  expect(d.snapshot().connection).toBe("unavailable");
  expect(d.export()).not.toContain("sensitive contents");
});
it("bounds response-body reads even if native fetch ignores abort", async () => {
  vi.useFakeTimers();
  try {
    const rpc = signedTransport(
      url,
      seed,
      async () => ({ ok: true, json: () => new Promise(() => {}) }) as Response,
      () => "id",
    );
    const task = rpc(
      "test",
      "/workspace",
      "connect",
      [],
      BACKGROUND_CONTEXT,
    ).catch((error) => error);
    await vi.advanceTimersByTimeAsync(15001);
    expect(await task).toMatchObject({ kind: "timeout" });
  } finally {
    vi.useRealTimers();
  }
});
it("does not treat installation stage metadata as proof of connectivity", () => {
  const d = new TermuxDiagnostics();
  d.record({ op: "setup.installing", result: "stage", elapsedMs: 0 });
  expect(d.snapshot().connection).toBe("unknown");
  expect(d.snapshot().checkedAt).toBeUndefined();
  expect(d.export()).toContain("setup.installing");
});
it("exports allowlisted file and shell error codes without arbitrary server text", async () => {
  const d = new TermuxDiagnostics();
  const rpc = signedTransport(
    url,
    seed,
    async () =>
      new Response(
        JSON.stringify(
          encode({
            ok: false,
            error: new FileError("not_found", "secret file"),
          }),
        ),
      ),
    () => "id",
    d.record,
  );
  await rpc("test", "/workspace", "readTextFile", [], BACKGROUND_CONTEXT);
  expect(d.export()).toContain("not_found");
  d.record({
    op: "readTextFile",
    result: "file_error",
    elapsedMs: 1,
    code: "secret token",
  });
  expect(d.export()).not.toContain("secret");
});
