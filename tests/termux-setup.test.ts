import { expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ed25519 } from "@noble/curves/ed25519.js";
import { startService } from "../components/termux-service/server";
import { signedTransport } from "../src/termux/environment";
import { TermuxSetup, type ProbeResult } from "../src/termux/setup";
const key = "a".repeat(64);
const hash = "b".repeat(64);
function fixture(
  results: ProbeResult[] = [{ kind: "offline" }, { kind: "ready", hash }],
) {
  let time = 0;
  const native = {
    status: vi.fn(async () => ({
      installed: true,
      granted: true,
      assetHash: hash,
      lastError: undefined as string | undefined,
    })),
    start: vi.fn(async () => ({ assetHash: hash })),
    stopBootstrap: vi.fn(async () => {}),
  };
  const probe = vi.fn(
    async () => results.shift() ?? ({ kind: "offline" } as ProbeResult),
  );
  const sleep = vi.fn(async (ms: number) => {
    time += ms;
  });
  const setup = new TermuxSetup({
    native,
    probe,
    sleep,
    now: () => time,
    timeoutMs: 4000,
  });
  const phases: string[] = [];
  const controller = new AbortController();
  const run = () => setup.run(key, controller.signal, (p) => phases.push(p));
  return { native, probe, sleep, setup, phases, controller, run };
}
it("installs offline service and waits for signed matching readiness", async () => {
  const f = fixture();
  await f.run();
  expect(f.native.start).toHaveBeenCalledWith(key);
  expect(f.phases).toEqual(["checking", "installing", "connecting", "ready"]);
  expect(f.native.stopBootstrap).toHaveBeenCalledTimes(1);
});
it("reuses matching running service without install permission", async () => {
  const f = fixture([{ kind: "ready", hash }]);
  f.native.status.mockResolvedValue({
    installed: true,
    granted: false,
    assetHash: hash,
    lastError: undefined,
  });
  await f.run();
  expect(f.native.start).not.toHaveBeenCalled();
});
it.each(["installed", "granted"] as const)(
  "rejects missing %s",
  async (field) => {
    const f = fixture();
    f.native.status.mockResolvedValue({
      installed: true,
      granted: true,
      assetHash: hash,
      lastError: undefined,
      [field]: false,
    });
    await expect(f.run()).rejects.toThrow(
      field === "installed" ? /install Termux/i : /permission/i,
    );
    expect(f.native.start).not.toHaveBeenCalled();
    expect(f.native.stopBootstrap).toHaveBeenCalledTimes(1);
  },
);
it.each([
  { kind: "ready", hash: "c".repeat(64) },
  { kind: "incompatible", message: "unauthorized" },
] as ProbeResult[])(
  "refuses existing incompatible service %j",
  async (result) => {
    const f = fixture([result]);
    await expect(f.run()).rejects.toThrow(/stop.*Termux.*retry/i);
    expect(f.native.start).not.toHaveBeenCalled();
  },
);
it("surfaces installer failures and times out without reporting ready", async () => {
  const f = fixture();
  f.native.status
    .mockResolvedValueOnce({
      installed: true,
      granted: true,
      assetHash: hash,
      lastError: undefined,
    })
    .mockResolvedValue({
      installed: true,
      granted: true,
      assetHash: hash,
      lastError: "pkg failed",
    });
  await expect(f.run()).rejects.toThrow("pkg failed");
  const g = fixture([{ kind: "offline" }]);
  await expect(g.run()).rejects.toThrow(/timed out/i);
  expect(g.phases).not.toContain("ready");
  expect(g.native.stopBootstrap).toHaveBeenCalledTimes(1);
});
it("cancels hanging boundary calls, rejects concurrent runs, and cleans bootstrap", async () => {
  const f = fixture();
  f.probe.mockImplementation(() => new Promise(() => {}));
  const running = f.run();
  await expect(f.run()).rejects.toThrow(/already/i);
  f.controller.abort();
  await expect(running).rejects.toThrow(/cancel/i);
  expect(f.phases).not.toContain("ready");
  expect(f.native.stopBootstrap).toHaveBeenCalledTimes(1);
});
it("validates only an exact public key and honors prior cancellation", async () => {
  const f = fixture();
  await expect(
    f.setup.run(key + "\n", f.controller.signal, () => {}),
  ).rejects.toThrow(/public/i);
  expect(f.native.start).not.toHaveBeenCalled();
  const g = fixture();
  g.controller.abort();
  await expect(g.run()).rejects.toThrow(/cancel/i);
  expect(g.native.start).not.toHaveBeenCalled();
});
it("serviceInfo requires signing, reports build identity, and writes no receipt/workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "moose-info-"));
  const seed = new Uint8Array(32).fill(7);
  const service = await startService({
    root,
    publicKey: ed25519.getPublicKey(seed),
    port: 0,
    buildHash: hash,
  });
  try {
    const rpc = signedTransport(service.url, seed, fetch, () =>
      crypto.randomUUID(),
    );
    expect(
      await rpc("setup", "/workspace", "serviceInfo", [], BACKGROUND_CONTEXT),
    ).toEqual({ ok: true, value: { protocol: 1, buildHash: hash } });
    expect(await readdir(join(root, ".requests"))).toEqual([]);
    expect(await readdir(root)).toEqual([".requests"]);
    expect(
      (await fetch(service.url, { method: "POST", body: "{}" })).status,
    ).toBe(401);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("interrupts polling and never marks a cancelled installation ready", async () => {
  const f = fixture([{ kind: "offline" }]);
  f.sleep.mockImplementation(async () => {
    f.controller.abort();
  });
  await expect(f.run()).rejects.toThrow(/cancel/i);
  expect(f.native.start).toHaveBeenCalledTimes(1);
  expect(f.native.stopBootstrap).toHaveBeenCalledTimes(1);
  expect(f.phases).not.toContain("ready");
});
it("bounds even a stalled native start and cleans after start rejection", async () => {
  const f = fixture();
  f.native.start.mockRejectedValue(new Error("RUN_COMMAND rejected"));
  await expect(f.run()).rejects.toThrow("RUN_COMMAND rejected");
  expect(f.native.stopBootstrap).toHaveBeenCalledTimes(1);
  vi.useFakeTimers();
  try {
    const g = fixture();
    g.native.start.mockImplementation(() => new Promise(() => {}));
    const running = expect(g.run()).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(4001);
    await running;
    expect(g.native.stopBootstrap).toHaveBeenCalledTimes(1);
    expect(g.phases).not.toContain("ready");
  } finally {
    vi.useRealTimers();
  }
});
it("bounds stalled bootstrap cleanup, reports failure, and releases single flight", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture([{ kind: "ready", hash }]);
    f.native.stopBootstrap.mockImplementationOnce(() => new Promise(() => {}));
    let failure: unknown;
    const running = f.run().catch((error) => {
      failure = error;
    });
    await vi.advanceTimersByTimeAsync(5001);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/cleanup.*timed out/i);
    expect(f.phases).not.toContain("ready");
    await running;
    f.probe.mockResolvedValue({ kind: "ready", hash });
    await f.run();
    expect(f.phases.at(-1)).toBe("ready");
  } finally {
    vi.useRealTimers();
  }
});
it("preserves installation failure when cleanup also stalls", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    f.native.start.mockRejectedValue(new Error("RUN_COMMAND rejected"));
    f.native.stopBootstrap.mockImplementation(() => new Promise(() => {}));
    let failure: unknown;
    const running = f.run().catch((error) => {
      failure = error;
    });
    await vi.advanceTimersByTimeAsync(5001);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/RUN_COMMAND rejected/);
    expect((failure as Error).message).toMatch(/cleanup.*timed out/i);
    await running;
  } finally {
    vi.useRealTimers();
  }
});
it("observes late cleanup rejection after its deadline", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture([{ kind: "ready", hash }]);
    f.native.stopBootstrap.mockImplementation(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("late native rejection")), 6000);
        }),
    );
    const running = expect(f.run()).rejects.toThrow(/cleanup.*timed out/i);
    await vi.advanceTimersByTimeAsync(5001);
    await running;
    await vi.advanceTimersByTimeAsync(1000);
  } finally {
    vi.useRealTimers();
  }
});
