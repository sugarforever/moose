import { build } from "esbuild";
import { createContext, runInContext } from "node:vm";
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
const root = await mkdtemp(join(tmpdir(), "moose-service-smoke-"));
const seed = new Uint8Array(32).fill(8);
const hex = (bytes) => Buffer.from(bytes).toString("hex");
await mkdir(join(root, ".requests"));
await writeFile(join(root, ".requests", "interrupted-receipt"), "");
const child = spawn(
  process.execPath,
  [
    "dist/termux/service.mjs",
    hex(ed25519.getPublicKey(seed)),
    "acknowledge-interrupted",
  ],
  {
    env: { ...process.env, MOOSE_TERMUX_ROOT: root },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let stderr = "";
child.stderr.on("data", (chunk) => (stderr += chunk));
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Service startup timed out: ${stderr}`)),
      10000,
    );
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Service exited ${code}: ${stderr}`));
    });
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  async function rpc(op, args) {
    const body = JSON.stringify({
      id: crypto.randomUUID(),
      time: Date.now(),
      workspace: "smoke",
      cwd: "/workspace",
      op,
      args,
    });
    const response = await fetch("http://127.0.0.1:18765/", {
      method: "POST",
      headers: {
        "X-Moose-Signature": hex(
          ed25519.sign(new TextEncoder().encode(body), seed),
        ),
      },
      body,
    });
    const result = await response.json();
    if (result.transportError || result.ok === false)
      throw new Error(JSON.stringify(result));
    return result;
  }
  await rpc("writeFile", ["input", "standalone"]);
  const job = (
    await rpc("exec", [
      "cat input > output; printf shell; printf error >&2",
      {},
    ])
  ).value;
  let output = "";
  let cursor = 0;
  for (;;) {
    const poll = await rpc("poll", [job, cursor]);
    for (const event of poll.events) {
      output += event.text;
      cursor++;
    }
    if (poll.result) {
      if (!poll.result.ok || poll.result.value.exitCode !== 0)
        throw new Error("Shell failed");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (output !== "shellerror" && output !== "errorshell")
    throw new Error("Missing stdout/stderr");
  if ((await rpc("readTextFile", ["output"])).value !== "standalone")
    throw new Error("File/shell workspaces differ");
  await rpc("ack", [job]);
  await rpc("cleanup", []);
  const portable = await build({
    entryPoints: ["src/termux/environment.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "Remote",
    write: false,
  });
  const realm = createContext({
    TextEncoder,
    TextDecoder,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch,
    uuid: () => crypto.randomUUID(),
  });
  runInContext(portable.outputFiles[0].text, realm);
  if (
    runInContext("typeof process + typeof Buffer + typeof require", realm) !==
    "undefinedundefinedundefined"
  )
    throw new Error("Node globals leaked");
  const passed = await runInContext(
    `(async()=>{
    const context={abortSignal:undefined,value:()=>undefined};
    const env=new Remote.TermuxEnvironment('portable',Remote.signedTransport('http://127.0.0.1:18765/',new Uint8Array(32).fill(8),fetch,uuid));
    const written=await env.writeFile('input','portable',context);
    const executed=await env.exec('cat input > output',undefined,context);
    const read=await env.readTextFile('output',context);
    await env.cleanup(context);
    return written.ok && executed.ok && read.ok && read.value==='portable';
  })()`,
    realm,
  );
  if (!passed) throw new Error("Portable signed execution failed");
  console.log(
    "Standalone packaged service passed real signed HTTP, files, shell, stdout/stderr and cleanup. Browser bundle also passed without Node globals. No model request.",
  );
} finally {
  child.kill("SIGTERM");
  if (child.exitCode === null)
    await new Promise((resolve) => child.once("exit", resolve));
  await rm(root, { recursive: true, force: true });
}
