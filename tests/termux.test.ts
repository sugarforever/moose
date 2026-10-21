import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  BACKGROUND_CONTEXT as ctx,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { startService } from "../components/termux-service/server";
import { TermuxEnvironment, signedTransport } from "../src/termux/environment";
const seed = new Uint8Array(32).fill(13);
async function fixture(
  use: (env: TermuxEnvironment, url: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "moose-termux-"));
  const service = await startService({
    root,
    publicKey: ed25519.getPublicKey(seed),
    port: 0,
  });
  const rpc = signedTransport(service.url, seed, fetch, () =>
    crypto.randomUUID(),
  );
  const env = new TermuxEnvironment("test", rpc);
  env.cwd = getOrThrow(await env.connect(ctx));
  try {
    await use(env, service.url);
  } finally {
    await env.cleanup(ctx);
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
}
it("authenticates loopback requests and rejects unsigned callers", async () =>
  fixture(async (env, url) => {
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(401);
    expect(
      getOrThrow(await env.writeFile("a.txt", "hello", ctx)),
    ).toBeUndefined();
    expect(getOrThrow(await env.readTextFile("a.txt", ctx))).toBe("hello");
    expect((await env.readTextFile("/etc/passwd", ctx)).ok).toBe(false);
  }));
it("runs argv, cwd/env and ordered stdout/stderr in the file workspace", async () =>
  fixture(async (env) => {
    await env.writeFile("input", "shared", ctx);
    const output: string[] = [];
    const result = await env.exec(
      ["sh", "-c", 'cat input; printf "$VALUE"; printf err >&2; exit 7'],
      {
        env: { VALUE: " value" },
        onOutput: (s, _c, i) => output.push(`${i.stream}:${s}`),
      },
      ctx,
    );
    expect(getOrThrow(result).exitCode).toBe(7);
    expect(output.join("")).toContain("shared");
    expect(output.join("")).toContain(" value");
    expect(output.join("")).toContain("stderr:err");
  }));
it("enforces timeout and cancels commands", async () =>
  fixture(async (env) => {
    expect(await env.exec("sleep 20", { timeout: 0.05 }, ctx)).toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
    const controller = new AbortController();
    const context = withAbortSignal(controller.signal, ctx);
    const task = env.exec("sleep 20", undefined, context);
    setTimeout(() => controller.abort(), 100);
    expect(await task).toMatchObject({ ok: false, error: { code: "aborted" } });
  }));
registerEnvConformance(
  {
    describe,
    expect,
    it: (name, run, timeout) => {
      // Explicitly unsupported capabilities remain visible as skipped upstream cases.
      if (/watch/.test(name)) it.skip(name, run);
      else it(name, run, timeout ?? 20000);
    },
  },
  "Termux HTTP ExecutionEnv",
  async (use) => fixture(async (env) => use(env)),
  { symlinks: false },
);

it("binds duplicate IDs to one body and refuses replay after service restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "moose-replay-"));
  let service = await startService({
    root,
    publicKey: ed25519.getPublicKey(seed),
    port: 0,
  });
  const body = JSON.stringify({
    id: "stable-side-effect",
    time: Date.now(),
    workspace: "test",
    cwd: "/workspace",
    op: "appendFile",
    args: ["counter", "once"],
  });
  const send = async (text = body) => {
    const signature = Array.from(
      ed25519.sign(new TextEncoder().encode(text), seed),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    return fetch(service.url, {
      method: "POST",
      headers: { "X-Moose-Signature": signature },
      body: text,
    });
  };
  try {
    expect((await (await send()).json()).ok).toBe(true);
    expect((await (await send()).json()).ok).toBe(true);
    expect((await send(body.replace("once", "twice"))).status).toBe(409);
    const rpc = signedTransport(service.url, seed, fetch, () =>
      crypto.randomUUID(),
    );
    const env = new TermuxEnvironment("test", rpc);
    expect(getOrThrow(await env.readTextFile("counter", ctx))).toBe("once");
    await service.close();
    service = await startService({
      root,
      publicKey: ed25519.getPublicKey(seed),
      port: 0,
    });
    expect(await (await send()).json()).toMatchObject({
      transportError: expect.stringContaining("outcome unknown"),
    });
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("rejects wrong signatures and symlink escape and isolates conversation directories", async () =>
  fixture(async (env, url) => {
    const wrong = new TermuxEnvironment(
      "test",
      signedTransport(url, new Uint8Array(32).fill(2), fetch, () =>
        crypto.randomUUID(),
      ),
    );
    expect(await wrong.connect(ctx)).toMatchObject({ ok: false });
    getOrThrow(await env.writeFile("private", "one", ctx));
    const other = new TermuxEnvironment(
      "other",
      signedTransport(url, seed, fetch, () => crypto.randomUUID()),
    );
    expect(getOrThrow(await other.exists("private", ctx))).toBe(false);
    getOrThrow(await env.exec("ln -s /tmp escape", undefined, ctx));
    expect(await env.writeFile("escape/moose-escape", "no", ctx)).toMatchObject(
      { ok: false, error: { code: "permission_denied" } },
    );
    await other.cleanup(ctx);
  }));
it("keeps spilled output inside the same workspace", async () =>
  fixture(async (env) => {
    const result = getOrThrow(
      await env.exec(
        "printf 123456789",
        { spill: { afterBytes: 2, afterLines: 2 } },
        ctx,
      ),
    );
    expect(result.spillPath).toBeTruthy();
    expect(getOrThrow(await env.readTextFile(result.spillPath!, ctx))).toBe(
      "123456789",
    );
  }));
it("refuses new shell side effects after an interrupted service until owner acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "moose-interrupted-"));
  let service = await startService({
    root,
    publicKey: ed25519.getPublicKey(seed),
    port: 0,
  });
  const rpc = signedTransport(service.url, seed, fetch, () =>
    crypto.randomUUID(),
  );
  try {
    await rpc("test", "/workspace", "exec", ["sleep 20", {}], ctx);
    await service.close();
    service = await startService({
      root,
      publicKey: ed25519.getPublicKey(seed),
      port: 0,
    });
    const env = new TermuxEnvironment(
      "test",
      signedTransport(service.url, seed, fetch, () => crypto.randomUUID()),
    );
    expect(await env.exec("touch repeated", undefined, ctx)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("acknowledg") },
    });
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("uses a stable tool task identity to avoid repeating effects during durable replay", async () =>
  fixture(async (env) => {
    const { withContextValue } = await import("@earendil-works/chord/context");
    const { executionRequestKey } =
      await import("../src/runtime/execution-request");
    const callContext = () =>
      withContextValue(
        executionRequestKey,
        { taskId: "durable-task-42", sequence: 0 },
        ctx,
      );
    getOrThrow(await env.appendFile("stable", "once", callContext()));
    getOrThrow(await env.appendFile("stable", "once", callContext()));
    expect(getOrThrow(await env.readTextFile("stable", ctx))).toBe("once");
  }));
it("cancels a late command start and kills descendants on timeout", async () =>
  fixture(async (env, url) => {
    const rpc = signedTransport(url, seed, fetch, () => crypto.randomUUID());
    await rpc("test", "/workspace", "cancel", ["late-command"], ctx);
    await rpc(
      "test",
      "/workspace",
      "exec",
      ["touch late-side-effect", {}],
      ctx,
      "late-command",
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(getOrThrow(await env.exists("late-side-effect", ctx))).toBe(false);
    expect(
      await env.exec(
        "(sleep 0.3; touch descendant-effect) & wait",
        { timeout: 0.05 },
        ctx,
      ),
    ).toMatchObject({ ok: false, error: { code: "timeout" } });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(getOrThrow(await env.exists("descendant-effect", ctx))).toBe(false);
  }));

it("reports output capacity explicitly rather than silently returning truncated success", async () =>
  fixture(async (env) => {
    const result = await env.exec("head -c 9000000 /dev/zero", undefined, ctx);
    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("output limit") },
    });
  }));
it("does not inherit arbitrary service secrets into shell processes", async () => {
  process.env.MOOSE_TEST_PRIVATE = "must-not-reach-shell";
  try {
    await fixture(async (env) => {
      let output = "";
      getOrThrow(
        await env.exec(
          'printf "%s/%s" "$MOOSE_TEST_PRIVATE" "$CUSTOM"',
          { env: { CUSTOM: "allowed" }, onOutput: (s) => (output += s) },
          ctx,
        ),
      );
      expect(output).toBe("/allowed");
    });
  } finally {
    delete process.env.MOOSE_TEST_PRIVATE;
  }
});

it("authenticates UTF-8 content split between HTTP chunks", async () =>
  fixture(async (_env, url) => {
    const { request } = await import("node:http");
    const body = Buffer.from(
      JSON.stringify({
        id: "utf8-chunks",
        time: Date.now(),
        workspace: "test",
        cwd: "/workspace",
        op: "writeFile",
        args: ["unicode", "中文"],
      }),
    );
    const signature = Buffer.from(ed25519.sign(body, seed)).toString("hex");
    const split = body.indexOf(Buffer.from("中")) + 1;
    const response = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = request(
          url,
          { method: "POST", headers: { "X-Moose-Signature": signature } },
          (res) => {
            let text = "";
            res.on("data", (chunk) => (text += chunk));
            res.on("end", () =>
              resolve({ status: res.statusCode!, body: text }),
            );
          },
        );
        req.on("error", reject);
        req.flushHeaders();
        req.write(body.subarray(0, split));
        setTimeout(() => req.end(body.subarray(split)), 30);
      },
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ ok: true });
  }));
it("starts fail-closed with a corrupt intent receipt so the owner can recover", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "moose-corrupt-"));
  await mkdir(join(root, ".requests"));
  await writeFile(join(root, ".requests", "broken"), "{");
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  try {
    service = await startService({
      root,
      publicKey: ed25519.getPublicKey(seed),
      port: 0,
    });
    const env = new TermuxEnvironment(
      "test",
      signedTransport(service.url, seed, fetch, () => crypto.randomUUID()),
    );
    expect((await env.connect(ctx)).ok).toBe(true);
    expect(await env.exec("touch unsafe", undefined, ctx)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("acknowledg") },
    });
  } finally {
    await service?.close();
    await rm(root, { recursive: true, force: true });
  }
});
