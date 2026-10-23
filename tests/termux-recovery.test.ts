import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  enabled: "yes",
  starts: 0,
  online: false,
  lastError: undefined as string | undefined,
  incompatible: false,
  operations: [] as string[],
  hash: "b".repeat(64),
  hold: undefined as undefined | (() => Promise<void>),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  PermissionsAndroid: {},
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) =>
    key.endsWith("enabled") ? f.enabled : "a".repeat(64),
  setItemAsync: async (key: string, value: string) => {
    if (key.endsWith("enabled")) f.enabled = value;
  },
}));
vi.mock("expo-crypto", () => ({
  getRandomBytes: () => new Uint8Array(32),
  randomUUID: () => crypto.randomUUID(),
}));
vi.mock("expo", () => ({
  requireOptionalNativeModule: () => ({
    status: async () => ({
      installed: true,
      granted: true,
      assetHash: f.hash,
      lastError: f.lastError,
    }),
    start: async () => {
      f.starts++;
      await f.hold?.();
      f.online = true;
      return { assetHash: f.hash };
    },
    stopBootstrap: async () => {},
  }),
}));
vi.mock("expo/fetch", () => ({
  fetch: async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    f.operations.push(body.op);
    if (!f.online) throw new TypeError("Network request failed");
    return new Response(
      JSON.stringify({
        ok: true,
        value:
          body.op === "serviceInfo"
            ? {
                protocol: 1,
                buildHash: f.incompatible ? "c".repeat(64) : f.hash,
              }
            : "/workspace",
      }),
    );
  },
}));
import { termux } from "../src/platform/termux";
beforeEach(() => {
  f.enabled = "yes";
  f.online = false;
  f.starts = 0;
  f.hold = undefined;
  f.lastError = undefined;
  f.incompatible = false;
  f.operations = [];
});
it("repairs a lost selected service without changing selection, then admits signed communication", async () => {
  await termux.ensureReady(new AbortController().signal);
  expect(f.online).toBe(true);
  expect(f.enabled).toBe("yes");
  await termux.ensureReady(new AbortController().signal);
  expect(f.starts).toBe(1);
});
it("does not start Termux when local files are selected", async () => {
  f.enabled = "no";
  await termux.ensureReady(new AbortController().signal);
  expect(f.starts).toBe(0);
});
it("serializes repair with selection and checks cancellation before starting queued work", async () => {
  let release!: () => void;
  f.hold = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const first = termux.ensureReady(new AbortController().signal);
  await vi.waitFor(() => expect(f.starts).toBe(1));
  const controller = new AbortController();
  const queued = termux.ensureReady(controller.signal);
  controller.abort();
  const rejected = expect(queued).rejects.toThrow();
  const selected = termux.select(false);
  try {
    await Promise.race([
      rejected,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Queued cancellation did not settle")),
          200,
        ),
      ),
    ]);
  } finally {
    release();
  }
  await first;
  await selected;
  expect(f.enabled).toBe("no");
  expect(f.starts).toBe(1);
});

it("refuses incompatible signed services without launching or changing selection", async () => {
  f.online = true;
  f.incompatible = true;
  await expect(
    termux.ensureReady(new AbortController().signal),
  ).rejects.toThrow(/incompatible/);
  expect(f.starts).toBe(0);
  expect(f.enabled).toBe("yes");
});
it("surfaces interrupted-command bootstrap refusal without acknowledging or replaying work", async () => {
  f.lastError = "Unconfirmed command result; inspect effects before recovery";
  await expect(
    termux.ensureReady(new AbortController().signal),
  ).rejects.toThrow(/Unconfirmed/);
  expect(f.enabled).toBe("yes");
  expect(f.starts).toBe(1);
  expect(f.operations).toEqual(["serviceInfo"]);
});
it("bounds the whole automatic check including time queued behind manual setup", async () => {
  let release!: () => void;
  f.hold = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const manual = termux.enable(true, new AbortController().signal, () => {});
  await vi.waitFor(() => expect(f.starts).toBe(1));
  vi.useFakeTimers();
  try {
    const auto = termux.ensureReady(new AbortController().signal);
    const rejected = expect(auto).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    release();
    await manual;
    expect(f.starts).toBe(1);
  } finally {
    vi.useRealTimers();
    release();
  }
});
