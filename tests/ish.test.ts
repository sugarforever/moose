import { expect, it } from "vitest";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import {
  createIshWorkspace,
  type IshBridge,
  encodeBase64,
  decodeBase64,
} from "../src/runtime/ish";

function bridge() {
  let listener: Parameters<IshBridge["subscribe"]>[0] | undefined;
  let cancel: (() => void) | undefined;
  const calls: unknown[][] = [];
  const native: IshBridge = {
    prepare: async () => {},
    subscribe(fn) {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    async execute(...args) {
      calls.push(args);
      listener?.({ commandId: args[1], stream: "stdout", data: "4oI=" });
      listener?.({ commandId: args[1], stream: "stderr", data: "ZXJyb3I=" });
      listener?.({ commandId: args[1], stream: "stdout", data: "rA==" });
      return { exitCode: 7, stdout: "4oKs", stderr: "ZXJyb3I=" };
    },
    cancel: async () => {
      cancel?.();
    },
    cleanup: async () => {},
  };
  return {
    native,
    calls,
    setCancel(fn: () => void) {
      cancel = fn;
    },
  };
}
it("roundtrips arbitrary binary without Node globals", () => {
  const bytes = Uint8Array.from({ length: 24577 }, (_, i) => i % 256);
  expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
});
it("decodes stdout and stderr separately across chunk boundaries and preserves argv", async () => {
  const { native, calls } = bridge();
  const env = createIshWorkspace("moose-chat-1", native);
  const output: [string, string][] = [];
  const result = await env.exec(
    ["/bin/printf", "%s", "literal; $(false)"],
    {
      env: { PROBE: "value" },
      onOutput(text, _ctx, info) {
        output.push([info.stream, text]);
      },
    },
    BACKGROUND_CONTEXT,
  );
  expect(result).toEqual({ ok: true, value: { exitCode: 7 } });
  expect(output).toEqual([
    ["stderr", "error"],
    ["stdout", "€"],
  ]);
  expect(calls[0][2]).toEqual(["/bin/printf", "%s", "literal; $(false)"]);
  expect(calls[0][4]).toMatchObject({ PROBE: "value" });
  await env.cleanup(BACKGROUND_CONTEXT);
});
it("cancels a running native command and waits for its cleanup", async () => {
  const fixture = bridge();
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  fixture.native.execute = async () => {
    entered();
    await new Promise<void>((r) => fixture.setCancel(r));
    return { exitCode: 137, stdout: "", stderr: "", cancelled: true };
  };
  const env = createIshWorkspace("moose-chat-2", fixture.native);
  const controller = new AbortController();
  const pending = env.exec(
    "sleep 30",
    undefined,
    withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
  );
  await started;
  controller.abort();
  const result = await pending;
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("aborted");
  await env.cleanup(BACKGROUND_CONTEXT);
});
it("preserves actionable native filesystem failures without starting a command", async () => {
  const { native, calls } = bridge();
  native.prepare = async () => {
    throw new Error("Native command journal capacity reached");
  };
  const env = createIshWorkspace("moose-chat-error", native);
  const result = await env.readTextFile("note", BACKGROUND_CONTEXT);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toContain("journal capacity");
  expect(calls).toHaveLength(0);
  await env.cleanup(BACKGROUND_CONTEXT);
});
