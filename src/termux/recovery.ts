import type { ExecutionGuard } from "../runtime/execution-owner";

/** Admission only: never retries a model request or tool with unknown effects. */
export function readyExecution(
  acquire: ExecutionGuard,
  ensureReady: (signal: AbortSignal) => Promise<void>,
): ExecutionGuard {
  return async (signal) => {
    const lease = await acquire(signal);
    const operation = new AbortController();
    const abort = () => operation.abort();
    signal?.addEventListener("abort", abort, { once: true });
    lease.signal.addEventListener("abort", abort, { once: true });
    if (signal?.aborted || lease.signal.aborted) abort();
    try {
      operation.signal.throwIfAborted();
      await ensureReady(operation.signal);
      operation.signal.throwIfAborted();
      return lease;
    } catch (error) {
      await lease.release();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      lease.signal.removeEventListener("abort", abort);
    }
  };
}

/** Activity checks own no runtime and are cancelled when the Activity is hidden. */
export function observeTermuxRecovery(
  appState: {
    currentState: string | null | undefined;
    addEventListener(
      event: "change",
      listener: (state: string) => void,
    ): { remove(): void };
  },
  ensureReady: (signal: AbortSignal) => Promise<void>,
  onError: (error: unknown) => void,
) {
  let current: AbortController | undefined;
  const change = (state: string) => {
    current?.abort();
    if (state !== "active") return;
    const controller = new AbortController();
    current = controller;
    void ensureReady(controller.signal).catch((error) => {
      if (!controller.signal.aborted) onError(error);
    });
  };
  const subscription = appState.addEventListener("change", change);
  change(appState.currentState ?? "unknown");
  return () => {
    current?.abort();
    subscription.remove();
  };
}
