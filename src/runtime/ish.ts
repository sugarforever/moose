import { createBashTool } from "@earendil-works/pi-durable/tools";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
  type Context,
} from "@earendil-works/chord/context";
import {
  createWorkspaceEnv,
  type WorkspaceBackend,
} from "pi-durable-expo-env/core";
import {
  ExecutionError,
  FileError,
  StreamDecoder,
  err,
  ok,
  type ExecutionEnv,
  type ShellExecOptions,
  type Result,
  type ShellExecResult,
  type WatchTarget,
  type WatchChange,
  type FileWatcher,
} from "@earendil-works/pi-durable/env";

export interface IshOutput {
  commandId: string;
  stream: "stdout" | "stderr";
  data: string;
}
export interface IshResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  cancelled?: boolean;
  timedOut?: boolean;
  omittedBytes?: number;
}
export interface IshBridge {
  prepare(workspaceId: string): Promise<void>;
  execute(
    workspaceId: string,
    commandId: string,
    argv: string[],
    cwd: string,
    env: Record<string, string>,
    inputBase64: string,
    timeoutMs: number,
  ): Promise<IshResult>;
  subscribe(listener: (event: IshOutput) => void): () => void;
  cancel(commandId: string): Promise<void>;
  cleanup(workspaceId: string): Promise<void>;
}
const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function encodeBase64(bytes: Uint8Array) {
  const pieces: string[] = [];
  for (let start = 0; start < bytes.length; start += 12288) {
    let part = "";
    for (let i = start; i < Math.min(start + 12288, bytes.length); i += 3) {
      const n =
        (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
      part +=
        alphabet[(n >>> 18) & 63] +
        alphabet[(n >>> 12) & 63] +
        (i + 1 < bytes.length ? alphabet[(n >>> 6) & 63] : "=") +
        (i + 2 < bytes.length ? alphabet[n & 63] : "=");
    }
    pieces.push(part);
  }
  return pieces.join("");
}
export function decodeBase64(value: string) {
  if (
    value.length % 4 ||
    /[^A-Za-z0-9+/=]/.test(value) ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    throw new Error("Invalid native base64");
  const size =
    (value.length / 4) * 3 -
    (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (let i = 0; i < value.length; i += 4) {
    const n =
      (alphabet.indexOf(value[i]) << 18) |
      (alphabet.indexOf(value[i + 1]) << 12) |
      ((alphabet.indexOf(value[i + 2]) & 63) << 6) |
      (alphabet.indexOf(value[i + 3]) & 63);
    if (offset < size) out[offset++] = (n >>> 16) & 255;
    if (offset < size) out[offset++] = (n >>> 8) & 255;
    if (offset < size) out[offset++] = n & 255;
  }
  return out;
}
const encoder = new TextEncoder();
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const guestEnv = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C",
  LC_ALL: "C",
};
let commandSequence = 0;
const commandId = () =>
  `ish-${Date.now().toString(36)}-${(++commandSequence).toString(36)}-${Math.random().toString(36).slice(2)}`;

const durableCommandId = Symbol.for("moose.ish.commandId");
/** Persist native intent before shell effects; unsafe tools are never replayed by Pi. */
export function createIshBashTool() {
  const tool = createBashTool();
  return {
    ...tool,
    replay: "unsafe" as const,
    async execute(
      args: Parameters<typeof tool.execute>[0],
      api: Parameters<typeof tool.execute>[1],
      context: Context,
    ) {
      const stable = await api.memo(
        "moose.ish.commandId",
        commandId(),
        context,
      );
      const env = api.env;
      if (!env) return tool.execute(args, api, context);
      const bound = new Proxy(env, {
        get(target, key) {
          if (key === "exec")
            return (
              command: string | readonly string[],
              options: ShellExecOptions | undefined,
              ctx: Context,
            ) =>
              target.exec(
                command,
                { ...options, [durableCommandId]: stable } as ShellExecOptions,
                ctx,
              );
          return Reflect.get(target, key);
        },
      });
      return tool.execute(args, { ...api, env: bound }, context);
    },
  };
}

/** Files and shell use one jailed guest root. No direct host fakefs access. */
export function createIshWorkspace(
  workspaceId: string,
  bridge: IshBridge,
): ExecutionEnv {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(workspaceId))
    throw new Error("Invalid iSH workspace ID");
  const rootUri = `file:///moose-ish/${workspaceId}`;
  let closing: Promise<void> | undefined;
  let ready: Promise<void> | undefined,
    closed = false;
  let tail: Promise<unknown> = Promise.resolve();
  let operationContext: Context = BACKGROUND_CONTEXT;
  const prepare = () =>
    (ready ??= bridge.prepare(workspaceId).catch((e) => {
      ready = undefined;
      throw e;
    }));
  const path = (uri: string) => {
    if (uri !== rootUri && !uri.startsWith(rootUri + "/"))
      throw new FileError("invalid", "Invalid guest URI");
    return "/workspace" + decodeURIComponent(uri.slice(rootUri.length));
  };
  async function invoke(
    argv: string[],
    cwd: string,
    env: Record<string, string>,
    input: Uint8Array,
    timeoutMs: number,
    context: Context,
    onChunk?: (stream: "stdout" | "stderr", bytes: Uint8Array) => void,
    stableId?: string,
  ) {
    context.abortSignal?.throwIfAborted();
    await prepare();
    context.abortSignal?.throwIfAborted();
    const id = stableId ?? commandId();
    let callbackError: unknown;
    const cancel = () => {
      void bridge.cancel(id).catch(() => {});
    };
    const unsubscribe = bridge.subscribe((event) => {
      if (event.commandId !== id || callbackError) return;
      try {
        onChunk?.(event.stream, decodeBase64(event.data));
      } catch (error) {
        callbackError = error;
        cancel();
      }
    });
    context.abortSignal?.addEventListener("abort", cancel, { once: true });
    try {
      const pending = bridge.execute(
        workspaceId,
        id,
        argv,
        cwd,
        env,
        encodeBase64(input),
        timeoutMs,
      );
      if (context.abortSignal?.aborted) cancel();
      const result = await pending;
      if (callbackError)
        throw new ExecutionError(
          "callback_error",
          "Shell output callback failed",
          callbackError instanceof Error ? callbackError : undefined,
        );
      if (context.abortSignal?.aborted)
        throw new ExecutionError("aborted", "Command cancelled");
      if (result.omittedBytes)
        throw new ExecutionError("unknown", "Native output limit exceeded");
      if (result.timedOut)
        throw new ExecutionError("timeout", "Command timed out");
      if (result.cancelled)
        throw new ExecutionError("aborted", "Command cancelled");
      return result;
    } finally {
      context.abortSignal?.removeEventListener("abort", cancel);
      unsubscribe();
    }
  }
  async function guest(
    argv: string[],
    input: Uint8Array = new Uint8Array(),
    context = operationContext,
  ) {
    const result = await invoke(
      argv,
      "/workspace",
      guestEnv,
      input,
      30000,
      context,
    ).catch((error: unknown) => {
      throw new FileError(
        context.abortSignal?.aborted ||
          (error instanceof ExecutionError && error.code === "aborted")
          ? "aborted"
          : "unknown",
        error instanceof Error
          ? error.message
          : "Native filesystem operation failed",
      );
    });
    if (result.exitCode !== 0) {
      const message = text(decodeBase64(result.stderr));
      const code =
        result.exitCode === 44 || /No such file/.test(message)
          ? "not_found"
          : /Permission denied/.test(message)
            ? "permission_denied"
            : /Not a directory/.test(message)
              ? "not_directory"
              : /Is a directory/.test(message)
                ? "is_directory"
                : "unknown";
      throw new FileError(code, message || "Guest filesystem operation failed");
    }
    return decodeBase64(result.stdout);
  }
  const backend: WorkspaceBackend = {
    async stat(uri) {
      try {
        const output = text(
          await guest([
            "/bin/sh",
            "-c",
            'if [ -e "$1" ] || [ -L "$1" ]; then /bin/busybox stat -L -c "%F\n%s\n%Y" -- "$1"; else exit 44; fi',
            "stat",
            path(uri),
          ]),
        );
        const [kind, size, mtime] = output.trimEnd().split("\n");
        if (kind !== "directory" && !kind.startsWith("regular"))
          throw new FileError(
            "invalid",
            "Only regular files and directories are supported",
          );
        return {
          kind: kind === "directory" ? "directory" : "file",
          size: Number(size),
          mtimeMs: Number(mtime) * 1000,
        };
      } catch (e) {
        if (e instanceof FileError && e.code === "not_found") return undefined;
        throw e;
      }
    },
    async read(uri, limit, signal) {
      const data = await guest(
        ["/bin/busybox", "head", "-c", String(limit + 1), "--", path(uri)],
        undefined,
        withAbortSignal(signal, BACKGROUND_CONTEXT),
      );
      if (data.length > limit)
        throw new FileError("invalid", "File exceeds byte limit");
      return data;
    },
    async write(uri, bytes) {
      await guest(["/bin/sh", "-c", 'cat > "$1"', "write", path(uri)], bytes);
    },
    async mkdir(uri, recursive) {
      await guest([
        "/bin/busybox",
        "mkdir",
        ...(recursive ? ["-p"] : []),
        "--",
        path(uri),
      ]);
    },
    async names(uri) {
      const parent = path(uri);
      const data = text(
        await guest([
          "/bin/busybox",
          "find",
          parent,
          "-mindepth",
          "1",
          "-maxdepth",
          "1",
          "-print0",
        ]),
      );
      return data
        .split("\0")
        .filter(Boolean)
        .map((value) => value.slice(parent.length + 1));
    },
    async remove(uri, recursive) {
      if (recursive) await guest(["/bin/busybox", "rm", "-r", "--", path(uri)]);
      else
        await guest([
          "/bin/sh",
          "-c",
          'if [ -d "$1" ] && ! [ -L "$1" ]; then rmdir -- "$1"; else rm -- "$1"; fi',
          "remove",
          path(uri),
        ]);
    },
    async move(source, destination) {
      await guest([
        "/bin/busybox",
        "mv",
        "--",
        path(source),
        path(destination),
      ]);
    },
  };
  const files = createWorkspaceEnv({ backend, rootUri });
  Object.defineProperty(files, "id", { value: `ish:${workspaceId}` });
  async function exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ) {
    const requestedCwd = options?.cwd ?? files.cwd;
    if (typeof requestedCwd !== "string" || requestedCwd.includes("\0"))
      return err(
        new ExecutionError("spawn_error", "Invalid working directory"),
      );
    const components: string[] = [];
    for (const part of (requestedCwd.startsWith("/")
      ? requestedCwd
      : files.cwd + "/" + requestedCwd
    ).split("/")) {
      if (part === "..") components.pop();
      else if (part && part !== ".") components.push(part);
    }
    const cwd = "/" + components.join("/");
    if (closed)
      return err(new ExecutionError("spawn_error", "Environment is closed"));
    if (context.abortSignal?.aborted)
      return err(new ExecutionError("aborted", "Command cancelled"));
    if (
      (typeof command !== "string" &&
        (!command.length ||
          command.some((s) => typeof s !== "string" || s.includes("\0")))) ||
      (typeof command === "string" && command.includes("\0"))
    )
      return err(new ExecutionError("spawn_error", "Invalid command"));
    if (
      options?.timeout !== undefined &&
      (!Number.isFinite(options.timeout) ||
        options.timeout <= 0 ||
        options.timeout > 86400)
    )
      return err(
        new ExecutionError(
          "spawn_error",
          "Timeout must be positive seconds, at most 86400",
        ),
      );
    let argv =
      typeof command === "string" ? ["/bin/sh", "-c", command] : [...command];
    if (!argv[0].startsWith("/")) {
      try {
        const found = await invoke(
          ["/bin/sh", "-c", 'command -v "$1"', "resolve", argv[0]],
          cwd,
          { ...guestEnv, ...options?.env },
          new Uint8Array(),
          30000,
          context,
        );
        if (found.exitCode !== 0)
          return err(
            new ExecutionError("spawn_error", "Guest program not found"),
          );
      } catch (e) {
        return err(
          e instanceof ExecutionError
            ? e
            : new ExecutionError(
                "spawn_error",
                "Unable to resolve guest program",
              ),
        );
      }
      argv = ["/bin/sh", "-c", 'exec "$@"', "exec", ...argv];
    }
    const decoders = {
      stdout: new StreamDecoder(),
      stderr: new StreamDecoder(),
    };
    const captured: string[] = [];
    const emit = (stream: "stdout" | "stderr", value: string) => {
      if (value) {
        captured.push(value);
        options?.onOutput?.(value, context, { stream });
      }
    };
    let outcome: Result<ShellExecResult, ExecutionError>;
    try {
      const result = await invoke(
        argv,
        cwd,
        { ...guestEnv, ...options?.env },
        new Uint8Array(),
        Math.min(2147483647, Math.ceil((options?.timeout ?? 120) * 1000)),
        context,
        (stream, bytes) => emit(stream, decoders[stream].decode(bytes)),
        (
          options as
            (ShellExecOptions & { [durableCommandId]?: string }) | undefined
        )?.[durableCommandId],
      );
      emit("stdout", decoders.stdout.decode());
      emit("stderr", decoders.stderr.decode());
      outcome = ok({ exitCode: result.exitCode } as {
        exitCode: number;
        spillPath?: string;
      });
    } catch (e) {
      const error =
        e instanceof ExecutionError
          ? e
          : new ExecutionError(
              context.abortSignal?.aborted
                ? "aborted"
                : (e as { code?: string })?.code === "spawn_error"
                  ? "spawn_error"
                  : "unknown",
              e instanceof Error ? e.message : "Native execution failed",
            );
      outcome = err(error);
    }
    const combined = captured.join("");
    if (
      options?.spill &&
      (encoder.encode(combined).length > options.spill.afterBytes ||
        combined.split("\n").length > options.spill.afterLines)
    ) {
      try {
        const spill = await files.createTempFile(
          { prefix: "shell-", suffix: ".log" },
          BACKGROUND_CONTEXT,
        );
        if (!spill.ok) throw spill.error;
        const bytes = encoder.encode(combined);
        if (bytes.length > 16 * 1024 * 1024)
          throw new Error("Decoded output exceeds the 16 MiB spill limit");
        // Spill artifacts may exceed the 8 MiB file-tool transfer bound, while
        // remaining within the actual guest regular-file/native-input limits.
        await guest(
          ["/bin/sh", "-c", 'cat > "$1"', "spill", spill.value],
          bytes,
          BACKGROUND_CONTEXT,
        );
        if (outcome.ok) outcome.value.spillPath = spill.value;
        else outcome.error.spillPath = spill.value;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (outcome.ok)
          outcome = err(
            new ExecutionError(
              "unknown",
              `Command finished (exit ${outcome.value.exitCode}); full output could not be saved: ${message}`,
            ),
          );
        else
          outcome.error.message += `; full output could not be saved: ${message}`;
      }
    }

    return outcome;
  }
  const watchers = new Set<() => void>();
  const originalReader = files.openBinaryReader.bind(files);
  files.openBinaryReader = async (p, options, context) => {
    if (context.abortSignal?.aborted)
      return err(new FileError("aborted", "Operation cancelled"));
    if (options?.noFollow) {
      const absolute = await files.absolutePath(p, context);
      if (!absolute.ok) return absolute;
      try {
        const result = await invoke(
          ["/bin/sh", "-c", 'test ! -L "$1"', "nofollow", absolute.value],
          "/workspace",
          guestEnv,
          new Uint8Array(),
          30000,
          context,
        );
        if (result.exitCode !== 0)
          return err(
            new FileError("invalid", "Final path is a symbolic link", p),
          );
      } catch (e) {
        return err(new FileError("unknown", String(e), p));
      }
    }
    return originalReader(p, undefined, context);
  };
  files.flushFile = async (p, context) => {
    const absolute = await files.absolutePath(p, context);
    if (!absolute.ok) return absolute;
    try {
      await guest(
        ["/bin/busybox", "sync", "-f", absolute.value],
        undefined,
        context,
      );
      return ok(undefined);
    } catch (e) {
      return err(
        e instanceof FileError ? e : new FileError("unknown", String(e), p),
      );
    }
  };
  async function snapshot(target: WatchTarget, context: Context) {
    const absolute = await files.absolutePath(target.path, context);
    if (!absolute.ok) throw absolute.error;
    const script =
      'if ! [ -e "$1" ] && ! [ -L "$1" ]; then exit 0; fi; ' +
      'find "$1" ' +
      (target.recursive ? "" : "-maxdepth 1 ") +
      `-exec /bin/sh -c 'for p do if [ -f "$p" ]; then printf "f "; cksum < "$p"; elif [ -d "$p" ]; then printf d; else printf l; fi; printf "\\0%s\\0" "$p"; done' watch {} +`;
    const output = await guest(
      ["/bin/sh", "-c", script, "watch", absolute.value],
      undefined,
      context,
    );
    if (output.length > 1024 * 1024)
      throw new FileError("invalid", "Watch exceeds snapshot bound");
    const parts = text(output).split("\0");
    if (parts.length > 20001)
      throw new FileError("invalid", "Watch exceeds entry bound");
    const entries: string[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const name = parts[i + 1];
      const relative = name.slice(absolute.value.length + 1);
      if (
        name !== absolute.value &&
        relative
          .split("/")
          .some(
            (segment) =>
              (target.exclude?.hidden && segment.startsWith(".")) ||
              target.exclude?.names?.includes(segment),
          )
      )
        continue;
      entries.push(JSON.stringify([name, parts[i]]));
    }
    return entries.sort().join("\n");
  }
  files.watch = async (targets, onChange, context) => {
    try {
      context.abortSignal?.throwIfAborted();
      if (closed) throw new FileError("invalid", "Environment is closed");
      const signatures = await Promise.all(
        targets.map((target) => snapshot(target, context)),
      );
      let stopped = false,
        pending: Promise<void> | undefined;
      const stop = () => {
        stopped = true;
        clearInterval(timer);
        watchers.delete(stop);
      };
      const timer = setInterval(() => {
        if (stopped || pending) return;
        pending = (async () => {
          for (let i = 0; i < targets.length && !stopped; i++) {
            const next = await snapshot(targets[i], BACKGROUND_CONTEXT);
            if (next !== signatures[i]) {
              signatures[i] = next;
              const absolute = await files.absolutePath(
                targets[i].path,
                BACKGROUND_CONTEXT,
              );
              if (absolute.ok && !stopped)
                onChange({ paths: [absolute.value] });
            }
          }
        })()
          .catch((error) => {
            if (!stopped) {
              stop();
              onChange({
                error:
                  error instanceof FileError
                    ? error
                    : new FileError("unknown", String(error)),
              });
            }
          })
          .finally(() => {
            pending = undefined;
          });
      }, 250);
      watchers.add(stop);
      return ok({
        mode: "polling" as const,
        async close() {
          stop();
          await pending;
        },
      });
    } catch (e) {
      return err(
        e instanceof FileError
          ? e
          : new FileError(
              context.abortSignal?.aborted ? "aborted" : "unknown",
              String(e),
            ),
      );
    }
  };
  const originalCleanup = files.cleanup.bind(files);
  const environment = Object.assign(files, { exec });
  // Serialize complete file operations against shell writes, not only individual backend calls.
  const wrapped = new Proxy(environment, {
    get(target, key, receiver) {
      if (key === "cleanup")
        return (context: Context) => {
          if (closing) return closing;
          closed = true;
          for (const stop of [...watchers]) stop();
          closing = (async () => {
            let failure: unknown;
            try {
              await bridge.cleanup(workspaceId);
            } catch (error) {
              failure = error;
            }
            await tail.catch(() => {});
            await originalCleanup(context);
            if (failure) throw failure;
          })();
          return closing;
        };
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const context = args.at(-1) as Context;
        const run = tail
          .catch(() => {})
          .then(async () => {
            if (closed)
              return key === "exec"
                ? err(
                    new ExecutionError("spawn_error", "Environment is closed"),
                  )
                : err(new FileError("invalid", "Environment is closed"));
            operationContext = context ?? BACKGROUND_CONTEXT;
            return value.apply(target, args);
          });
        tail = run;
        return run;
      };
    },
  });
  return wrapped;
}
