import { getRandomValues } from "expo-crypto";
import { installPromiseWithResolvers } from "./compat";

installPromiseWithResolvers();

// Hermes is a JavaScript engine, not Node. Supply only portable APIs needed by Pi.
if (!globalThis.crypto)
  Object.defineProperty(globalThis, "crypto", {
    value: { getRandomValues },
    configurable: true,
  });
else if (!globalThis.crypto.getRandomValues)
  Object.defineProperty(globalThis.crypto, "getRandomValues", {
    value: getRandomValues,
  });

if (!AbortSignal.prototype.throwIfAborted) {
  AbortSignal.prototype.throwIfAborted = function () {
    if (this.aborted) throw this.reason ?? new Error("Aborted");
  };
}
if (!AbortSignal.any) {
  AbortSignal.any = (signals: AbortSignal[]) => {
    const controller = new AbortController();
    const cleanup = () =>
      signals.forEach((signal) => signal.removeEventListener("abort", onAbort));
    const onAbort = () => {
      const aborted = signals.find((signal) => signal.aborted);
      if (aborted) {
        cleanup();
        controller.abort(aborted.reason);
      }
    };
    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort(signal.reason);
        break;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (controller.signal.aborted) cleanup();
    return controller.signal;
  };
}
if (!AbortSignal.timeout) {
  AbortSignal.timeout = (milliseconds: number) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new Error("Request timed out")),
      milliseconds,
    );
    return controller.signal;
  };
}
