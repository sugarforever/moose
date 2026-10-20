import { createServer } from "node:http";
import {
  mkdir,
  readFile,
  lstat,
  realpath,
  readdir,
  open,
  rename,
} from "node:fs/promises";
import { resolve, relative, sep, join } from "node:path";
import { randomUUID } from "node:crypto";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  FileError,
  type Result,
  type ShellExecResult,
  ExecutionError,
} from "@earendil-works/pi-durable/env";
import {
  BACKGROUND_CONTEXT as context,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { ed25519 } from "@noble/curves/ed25519.js";
import { encode, decode, unhex, fileMethods } from "../../src/termux/wire.ts";

type Job = {
  workspace: string;
  controller: AbortController;
  events: { text: string; stream: string }[];
  bytes: number;
  result?: Result<ShellExecResult, ExecutionError>;
  done: Promise<void>;
};
const MAX_BODY = 12 * 1024 * 1024;
const MAX_OUTPUT = 8 * 1024 * 1024;
export async function startService(options: {
  root: string;
  publicKey: Uint8Array;
  port?: number;
}) {
  await mkdir(resolve(options.root), { recursive: true, mode: 0o700 });
  const root = await realpath(resolve(options.root));
  const journal = resolve(root, ".requests");
  await mkdir(journal, { recursive: true, mode: 0o700 });
  const blocked = new Set<string>();
  for (const name of await readdir(journal)) {
    if (name.startsWith(".tmp-")) continue;
    try {
      const record = JSON.parse(await readFile(resolve(journal, name), "utf8"));
      if (typeof record.op !== "string" || typeof record.workspace !== "string")
        throw new Error("Invalid receipt");
      if (record.op === "exec" && !record.acknowledged)
        blocked.add(record.workspace);
    } catch {
      blocked.add("*");
    }
  }
  async function syncDirectory(path: string) {
    const directory = await open(path, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  await syncDirectory(root);
  async function durableRecord(id: string, value: unknown, exclusive = false) {
    // An incomplete exclusive intent remains a fail-closed marker on startup.
    // Acknowledgements replace the old complete receipt atomically.
    const path = resolve(journal, exclusive ? id : `.tmp-${randomUUID()}`);
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    if (!exclusive) await rename(path, resolve(journal, id));
    await syncDirectory(journal);
  }
  const inheritedEnv = Object.fromEntries(
    [
      "PATH",
      "HOME",
      "TMPDIR",
      "PREFIX",
      "LANG",
      "LC_ALL",
      "ANDROID_ROOT",
      "ANDROID_DATA",
    ].flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]],
    ),
  );
  const envs = new Map<string, NodeExecutionEnv>();
  const handles = new Map<string, { workspace: string; reader: any }>();
  const jobs = new Map<string, Job>();
  const cancelled = new Set<string>();
  const requests = new Map<
    string,
    { body: string; promise: Promise<unknown> }
  >();
  const publicKey = options.publicKey.slice();
  const isInside = (base: string, path: string) =>
    path === base || path.startsWith(base + sep);
  async function environment(workspace: string, cwd: string) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(workspace))
      throw new Error("Invalid workspace");
    const base = resolve(root, "workspaces", workspace);
    await mkdir(base, { recursive: true, mode: 0o700 });
    if ((await realpath(base)) !== base)
      throw new Error("Workspace symlink rejected");
    let env = envs.get(workspace);
    if (!env) {
      env = new NodeExecutionEnv({ cwd: base });
      env.createTempFile = async (settings, ctx) => {
        const prefix = settings?.prefix ?? "tmp-";
        const suffix = settings?.suffix ?? "";
        if (/[\/\\]/.test(prefix + suffix))
          return {
            ok: false,
            error: new FileError("invalid", "Invalid temp name"),
          };
        const path = resolve(base, `${prefix}${randomUUID()}${suffix}`);
        const result = await env!.writeFile(path, "", ctx);
        return result.ok ? { ok: true, value: path } : result;
      };
      envs.set(workspace, env);
    }
    const candidate = cwd === "/workspace" ? base : resolve(base, cwd);
    if (!isInside(base, candidate))
      throw new FileError("permission_denied", "cwd outside workspace");
    // Each request gets its own cwd wrapper; commands and readers are owned by the pooled environment.
    return { env, base, cwd: candidate };
  }
  async function safePath(base: string, cwd: string, path: unknown) {
    if (typeof path !== "string")
      throw new FileError("invalid", "Expected path");
    const target =
      path === "/workspace"
        ? base
        : path.startsWith("/workspace/")
          ? resolve(base, path.slice(11))
          : resolve(cwd, path);
    if (!isInside(base, target))
      throw new FileError("permission_denied", "Path outside workspace");
    let current = base;
    for (const part of relative(base, target).split(sep).filter(Boolean)) {
      current = resolve(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink())
          throw new FileError(
            "permission_denied",
            "Symlink paths are unsupported",
          );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    return target;
  }
  async function dispatch(message: any) {
    const { workspace, op } = message;
    const { env, base, cwd } = await environment(workspace, message.cwd);
    const args = decode(message.args) as any[];
    if (op === "connect") return { ok: true, value: base };
    if (op === "poll" || op === "cancel" || op === "ack") {
      const job = jobs.get(args[0]);
      if (op === "cancel" && !job) {
        cancelled.add(`${workspace}:${args[0]}`);
        return { ok: true };
      }
      if (!job || job.workspace !== workspace)
        throw new Error(
          "Command unavailable after service restart; outcome unknown",
        );
      if (op === "ack") {
        if (!job.result) throw new Error("Command still running");
        await durableRecord(args[0], {
          op: "exec",
          workspace,
          acknowledged: true,
        });
        return { ok: true };
      }
      if (op === "cancel") {
        job.controller.abort();
        await job.done;
        return { ok: true };
      }
      const cursor = args[1];
      if (
        !Number.isSafeInteger(cursor) ||
        cursor < 0 ||
        cursor > job.events.length
      )
        throw new Error("Invalid output cursor");
      return {
        events: job.events.slice(cursor, cursor + 128),
        result: cursor + 128 >= job.events.length ? job.result : undefined,
      };
    }
    if (op === "cleanup") {
      for (const job of jobs.values())
        if (job.workspace === workspace) job.controller.abort();
      await Promise.all(
        [...jobs.values()]
          .filter((j) => j.workspace === workspace)
          .map((j) => j.done),
      );
      for (const [id, handle] of handles)
        if (handle.workspace === workspace) {
          await handle.reader.close(context);
          handles.delete(id);
        }
      await env.cleanup(context);
      for (const [id, job] of jobs)
        if (job.workspace === workspace) jobs.delete(id);
      envs.delete(workspace);
      return { ok: true };
    }
    if (op === "handle") {
      const [id, method, ...values] = args;
      const handle = handles.get(id);
      if (!handle)
        return method === "close"
          ? { ok: true }
          : {
              ok: false,
              error: new FileError(
                "invalid",
                "Reader closed or service restarted",
              ),
            };
      if (handle.workspace !== workspace)
        return {
          ok: false,
          error: new FileError(
            "permission_denied",
            "Reader belongs to another workspace",
          ),
        };
      if (
        !["info", "read", "scanLines", "readLine", "next", "close"].includes(
          method,
        ) ||
        typeof handle.reader[method] !== "function"
      )
        throw new Error("Invalid reader operation");
      if (
        method === "next" &&
        (!Number.isSafeInteger(values[0]) || values[0] > 1024)
      )
        return {
          ok: false,
          error: new FileError(
            "invalid",
            "Directory page must be at most 1024 entries",
          ),
        };
      if (
        method === "read" &&
        (!Number.isSafeInteger(values[1]) || values[1] > 1024 * 1024)
      )
        return {
          ok: false,
          error: new FileError("invalid", "Read page must be at most 1 MiB"),
        };
      const result = await handle.reader[method](...values, context);
      if (method === "close") {
        handles.delete(id);
        return { ok: true };
      }
      return result;
    }
    if (op === "exec") {
      if (blocked.has(workspace) || blocked.has("*"))
        throw new Error(
          "Unacknowledged shell outcome after restart; owner acknowledgement required in Termux",
        );
      if (jobs.size >= 100)
        throw new Error("Command capacity exceeded; cleanup required");
      const [command, settings] = args;
      if (settings.timeout === undefined) settings.timeout = 600;
      if (!(
        typeof command === "string" ||
        (Array.isArray(command) && command.every((x) => typeof x === "string"))
      ))
        throw new Error("Invalid command");
      const commandCwd = await safePath(base, cwd, settings.cwd ?? cwd);
      const id = message.id;
      const controller = new AbortController();
      if (cancelled.has(`${workspace}:${id}`)) controller.abort();
      const job: Job = {
        workspace,
        controller,
        events: [],
        bytes: 0,
        done: Promise.resolve(),
      };
      jobs.set(id, job);
      job.done = (async () => {
        job.result = await env.exec(
          command,
          {
            ...settings,
            env: {
              ...(settings.inheritEnv === false ? {} : inheritedEnv),
              ...settings.env,
            },
            inheritEnv: false,
            cwd: commandCwd,
            onOutput: (text, _ctx, info) => {
              job.bytes += Buffer.byteLength(text);
              if (job.bytes > MAX_OUTPUT) {
                controller.abort();
                return;
              }
              job.events.push({ text, stream: info.stream });
            },
          },
          withAbortSignal(controller.signal, context),
        );
        if (job.bytes > MAX_OUTPUT)
          job.result = {
            ok: false,
            error: new ExecutionError(
              "unknown",
              "Termux output limit exceeded (8 MiB); command cancelled",
            ),
          };
      })();
      return { ok: true, value: id };
    }
    const readerOps = [
      "openBinaryReader",
      "openDirReader",
      "openTextLineReader",
    ];
    if (
      !(fileMethods as readonly string[]).includes(op) &&
      !readerOps.includes(op)
    )
      throw new Error("Unsupported operation");
    if (op === "joinPath") return { ok: true, value: join(...args[0]) };
    if (op === "createTempDir" || op === "createTempFile") {
      // Upstream temp paths are system-wide, so use workspace-owned temporary paths instead.
      const settings = args[0];
      const prefix =
        (typeof settings === "string" ? settings : settings?.prefix) ?? "tmp-";
      const suffix =
        (typeof settings === "object" ? settings?.suffix : "") ?? "";
      if (/[\/\\]/.test(prefix + suffix))
        return {
          ok: false,
          error: new FileError("invalid", "Invalid temporary name"),
        };
      const path = resolve(base, `${prefix}${randomUUID()}${suffix}`);
      const result =
        op === "createTempDir"
          ? await env.createDir(path, undefined, context)
          : await env.writeFile(path, "", context);
      return result.ok ? { ok: true, value: path } : result;
    }
    args[0] = await safePath(base, cwd, args[0]);
    if (op === "renameFile") args[1] = await safePath(base, cwd, args[1]);
    if (["readTextFile", "readTextLines", "readBinaryFile"].includes(op)) {
      const info = await env.fileInfo(args[0], context);
      if (info.ok && info.value.size > 1024 * 1024)
        return {
          ok: false,
          error: new FileError(
            "invalid",
            "Whole-file reads limited to 1 MiB; use openBinaryReader for larger files",
          ),
        };
    }
    if (
      ["writeFile", "appendFile"].includes(op) &&
      (typeof args[1] === "string"
        ? Buffer.byteLength(args[1])
        : args[1]?.length) >
        1024 * 1024
    )
      return {
        ok: false,
        error: new FileError("invalid", "Write payload limited to 1 MiB"),
      };
    const result = await (env as any)[op](...args, context);
    if (readerOps.includes(op) && result.ok) {
      if (handles.size >= 256) {
        await result.value.close(context);
        return {
          ok: false,
          error: new FileError("invalid", "Too many open readers"),
        };
      }
      const id = randomUUID();
      handles.set(id, { workspace, reader: result.value });
      return { ok: true, value: id };
    }
    return result;
  }
  const server = createServer(async (req, res) => {
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(encode(value)));
    };
    if (req.method !== "POST" || req.url !== "/" || req.headers.origin) {
      reply(403, {});
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > MAX_BODY) {
          reply(413, {});
          return;
        }
        chunks.push(bytes);
      }
      const bytes = Buffer.concat(chunks, length);
      const body = bytes.toString("utf8");
      const signature = req.headers["x-moose-signature"];
      if (
        typeof signature !== "string" ||
        !/^([0-9a-f]{128})$/.test(signature) ||
        !ed25519.verify(unhex(signature), bytes, publicKey)
      ) {
        reply(401, {});
        return;
      }
      const message = JSON.parse(body);
      if (
        !/^[a-zA-Z0-9_-]{1,240}$/.test(message.id) ||
        !Number.isFinite(message.time) ||
        Math.abs(Date.now() - message.time) > 60000
      ) {
        reply(401, {});
        return;
      }
      const cacheable = ![
        "connect",
        "poll",
        "fileInfo",
        "exists",
        "readTextFile",
        "readTextLines",
        "readBinaryFile",
        "listDir",
        "absolutePath",
        "canonicalPath",
        "joinPath",
      ].includes(message.op);
      const identity = JSON.stringify({ ...message, time: 0 });
      const cached = cacheable ? requests.get(message.id) : undefined;
      if (cached) {
        if (cached.body !== identity) {
          reply(409, {});
          return;
        }
        reply(200, await cached.promise);
        return;
      }
      if (requests.size >= 10000) {
        reply(503, { transportError: "Restart service; request cache full" });
        return;
      }
      const promise = (async () => {
        const mutating = cacheable;
        if (mutating) {
          try {
            await durableRecord(
              message.id,
              {
                op: message.op,
                workspace: message.workspace,
                acknowledged: false,
              },
              true,
            );
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "EEXIST")
              throw new Error(
                "Previous request outcome unknown; refusing replay after restart",
              );
            throw e;
          }
        }
        try {
          return await dispatch(message);
        } catch (e) {
          if (e instanceof FileError) return { ok: false, error: e };
          throw e;
        }
      })();
      if (cacheable) requests.set(message.id, { body: identity, promise });
      reply(200, await promise);
    } catch (e) {
      reply(200, {
        transportError: e instanceof Error ? e.message : "Request failed",
      });
    }
  });
  server.requestTimeout = 15000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 18765, "127.0.0.1", resolve);
  });
  const address = server.address() as { port: number };
  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const job of jobs.values()) job.controller.abort();
      await Promise.all([...jobs.values()].map((j) => j.done));
      for (const h of handles.values()) await h.reader.close(context);
      for (const env of envs.values()) await env.cleanup(context);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
