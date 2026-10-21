import { expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  BACKGROUND_CONTEXT as ctx,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { startService } from "../components/termux-service/server";
import {
  signedTransport,
  TermuxEnvironment,
  type Rpc,
} from "../src/termux/environment";
import { runTermuxSelfTest } from "../src/termux/self-test";
async function fixture(use: (rpc: Rpc, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "moose-self-test-"));
  const seed = new Uint8Array(32).fill(7);
  const service = await startService({
    root,
    publicKey: ed25519.getPublicKey(seed),
    port: 0,
  });
  try {
    await use(
      signedTransport(service.url, seed, fetch, () => crypto.randomUUID()),
      root,
    );
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
}
it("checks real signed file and bash execution, removes its workspace and preserves conversation files", async () =>
  fixture(async (rpc, root) => {
    const conversation = new TermuxEnvironment("conversation", rpc);
    await conversation.writeFile("hello.txt", "existing", ctx);
    const phases: string[] = [];
    await runTermuxSelfTest(rpc, "unique", ctx, (phase) => phases.push(phase));
    expect(phases).toEqual(["connect", "write", "read", "bash", "cleanup"]);
    expect(await conversation.readTextFile("hello.txt", ctx)).toEqual({
      ok: true,
      value: "existing",
    });
    expect(await readdir(join(root, "workspaces"))).toEqual([
      "conversation",
      "diagnostics-unique",
    ]);
    expect(
      await readdir(join(root, "workspaces", "diagnostics-unique")),
    ).toEqual([]);
    await conversation.cleanup(ctx);
  }));
it.each(["failure", "cancel"])(
  "cleans its isolated workspace after %s",
  async (mode) =>
    fixture(async (rpc, root) => {
      const abort = new AbortController();
      const wrapped: Rpc = async (...args) => {
        if (args[2] === "readTextFile") {
          if (mode === "cancel") abort.abort();
          else throw new Error("controlled read failure");
        }
        return rpc(...args);
      };
      wrapped.newId = rpc.newId;
      await expect(
        runTermuxSelfTest(
          wrapped,
          "unique",
          withAbortSignal(abort.signal, ctx),
          () => {},
        ),
      ).rejects.toThrow();
      expect(
        await readdir(join(root, "workspaces", "diagnostics-unique")),
      ).toEqual([]);
    }),
);
it("a fresh self-test works after an unknown shell outcome and service restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "moose-self-test-restart-"));
  const seed = new Uint8Array(32).fill(9);
  const options = { root, publicKey: ed25519.getPublicKey(seed), port: 0 };
  let service = await startService(options);
  const transport = () =>
    signedTransport(service.url, seed, fetch, () => crypto.randomUUID());
  try {
    const rpc = transport();
    const interrupted: Rpc = async (...args) => {
      const value = await rpc(...args);
      if (args[2] === "exec") throw new Error("controlled lost exec response");
      return value;
    };
    interrupted.newId = rpc.newId;
    await expect(
      runTermuxSelfTest(interrupted, "first", ctx, () => {}),
    ).rejects.toThrow("lost exec response");
    await service.close();
    service = await startService(options);
    const restarted = transport();
    const old = new TermuxEnvironment("diagnostics-first", restarted);
    expect(
      await old.exec(["bash", "-c", "true"], undefined, ctx),
    ).toMatchObject({
      ok: false,
      error: {
        message: expect.stringContaining("Unacknowledged shell outcome"),
      },
    });
    await runTermuxSelfTest(restarted, "second", ctx, () => {});
    expect(
      await readdir(join(root, "workspaces", "diagnostics-second")),
    ).toEqual([]);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
