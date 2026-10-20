import { executionRequestId } from "../runtime/execution-request";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  FileError,
  ExecutionError,
  type ExecutionEnv,
  type ShellExecOptions,
  type ShellExecResult,
  type Result,
} from "@earendil-works/pi-durable/env";
import { ed25519 } from "@noble/curves/ed25519.js";
import { encode, decode, hex, fileMethods } from "./wire";
export type Rpc = ((
  workspace: string,
  cwd: string,
  op: string,
  args: unknown[],
  context: Context,
  requestId?: string,
) => Promise<any>) & { newId?: () => string };
export function signedTransport(
  url: string,
  seed: Uint8Array,
  fetcher: typeof fetch,
  uuid: () => string,
): Rpc {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url))
    throw new Error("Termux requires an IPv4 loopback URL");
  const rpc: Rpc = async (workspace, cwd, op, args, context, requestId) => {
    const body = JSON.stringify({
      id: requestId ?? uuid(),
      time: Date.now(),
      workspace,
      cwd,
      op,
      args: encode(args),
    });
    const signature = hex(ed25519.sign(new TextEncoder().encode(body), seed));
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (context.abortSignal?.aborted) abort();
    context.abortSignal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 15000);
    try {
      const response = await fetcher(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Moose-Signature": signature,
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(`Termux connection rejected (${response.status})`);
      const result = decode(await response.json());
      if (result?.transportError) throw new Error(result.transportError);
      return result;
    } finally {
      clearTimeout(timeout);
      context.abortSignal?.removeEventListener("abort", abort);
    }
  };
  rpc.newId = uuid;
  return rpc;
}
export interface TermuxEnvironment extends ExecutionEnv {}
export class TermuxEnvironment {
  readonly id: string;
  cwd = "/workspace";
  private rpc: Rpc;
  private workspace: string;
  constructor(workspace: string, rpc: Rpc) {
    this.workspace = workspace;
    this.rpc = rpc;
    this.id = `termux:${workspace}`;
  }
  private requestId(context: Context) {
    const id = executionRequestId(context);
    return id ? `${this.workspace}-${id}` : undefined;
  }
  async invoke(op: string, args: unknown[], context: Context): Promise<any> {
    if (context.abortSignal?.aborted)
      return { ok: false, error: new FileError("aborted", "aborted") };
    try {
      return await this.rpc(
        this.workspace,
        this.cwd,
        op,
        args,
        context,
        this.requestId(context),
      );
    } catch (error) {
      return {
        ok: false,
        error: new FileError(
          context.abortSignal?.aborted ? "aborted" : "unknown",
          error instanceof Error
            ? error.message
            : "Termux unavailable; outcome unknown. Do not repeat side effects blindly.",
        ),
      };
    }
  }
  connect(context: Context) {
    return this.invoke("connect", [], context) as Promise<
      Result<string, FileError>
    >;
  }
  async openHandle(op: string, args: unknown[], context: Context) {
    const result = await this.invoke(op, args, context);
    if (!result.ok) return result;
    const handle = result.value;
    const call = (method: string, values: unknown[], ctx: Context) =>
      this.invoke("handle", [handle, method, ...values], ctx);
    return {
      ok: true as const,
      value: {
        info: (ctx: Context) => call("info", [], ctx),
        read: (offset: number, length: number, ctx: Context) =>
          call("read", [offset, length], ctx),
        scanLines: (options: unknown, ctx: Context) =>
          call("scanLines", [options], ctx),
        readLine: (ctx: Context) => call("readLine", [], ctx),
        next: (count: number, ctx: Context) => call("next", [count], ctx),
        close: async (ctx: Context) => {
          const result = await call("close", [], ctx);
          if (!result.ok) throw result.error;
        },
      },
    };
  }
  openBinaryReader(path: string, options: unknown, ctx: Context) {
    return this.openHandle("openBinaryReader", [path, options], ctx);
  }
  openDirReader(path: string, ctx: Context) {
    return this.openHandle("openDirReader", [path], ctx);
  }
  openTextLineReader(path: string, ctx: Context) {
    return this.openHandle("openTextLineReader", [path], ctx);
  }
  async watch() {
    return {
      ok: false as const,
      error: new FileError("not_supported", "Termux watch is unavailable"),
    };
  }
  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    let commandId: string | undefined;
    let cursor = 0;
    try {
      if (context.abortSignal?.aborted)
        return { ok: false, error: new ExecutionError("aborted", "aborted") };
      const { onOutput, ...rest } = options ?? {};
      commandId = this.requestId(context) ?? this.rpc.newId?.();
      const started = await this.rpc(
        this.workspace,
        this.cwd,
        "exec",
        [command, rest],
        context,
        commandId,
      );
      if (!started.ok) return started;
      commandId = started.value;
      for (;;) {
        if (context.abortSignal?.aborted) {
          await this.rpc(
            this.workspace,
            this.cwd,
            "cancel",
            [commandId],
            BACKGROUND_CONTEXT,
          );
          return { ok: false, error: new ExecutionError("aborted", "aborted") };
        }
        const state = await this.rpc(
          this.workspace,
          this.cwd,
          "poll",
          [commandId, cursor],
          context,
        );
        for (const event of state.events) {
          try {
            onOutput?.(event.text, context, { stream: event.stream });
          } catch (error) {
            throw new ExecutionError(
              "callback_error",
              error instanceof Error ? error.message : "Output callback failed",
            );
          }
          cursor++;
        }
        if (state.result) {
          await this.rpc(
            this.workspace,
            this.cwd,
            "ack",
            [commandId],
            BACKGROUND_CONTEXT,
          );
          return state.result;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } catch (error) {
      if (commandId)
        await this.rpc(
          this.workspace,
          this.cwd,
          "cancel",
          [commandId],
          BACKGROUND_CONTEXT,
        ).catch(() => {});
      return {
        ok: false,
        error:
          error instanceof ExecutionError
            ? error
            : new ExecutionError(
                context.abortSignal?.aborted ? "aborted" : "unknown",
                `Termux outcome unknown; do not automatically repeat: ${error instanceof Error ? error.message : "transport failed"}`,
              ),
      };
    }
  }
  async cleanup(context: Context) {
    const result = await this.invoke("cleanup", [], context);
    if (!result.ok) throw result.error;
  }
}
for (const method of fileMethods) {
  Object.defineProperty(TermuxEnvironment.prototype, method, {
    value: function (this: TermuxEnvironment, ...args: unknown[]) {
      const context = args.pop() as Context;
      return this.invoke(method, args, context);
    },
  });
}
