export type NativeSetupStatus = {
  installed: boolean;
  granted: boolean;
  assetHash: string;
  lastError?: string;
  pending?: boolean;
};
export type SetupPhase = "checking" | "installing" | "connecting" | "ready";
export type ProbeResult =
  | { kind: "ready"; hash: string }
  | { kind: "offline" }
  | { kind: "incompatible"; message: string };
type Options = {
  native: {
    status(): Promise<NativeSetupStatus>;
    start(publicKey: string): Promise<{ assetHash: string }>;
    stopBootstrap(): Promise<void>;
  };
  probe(signal: AbortSignal): Promise<ProbeResult>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
};
const cancelled = () => new Error("Termux setup cancelled");
const timedOut = () =>
  new Error(
    "Termux setup timed out. Open Termux, check installation, and retry.",
  );
function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
/** User-initiated setup; owns no credentials or environment preferences. */
export class TermuxSetup {
  private running = false;
  constructor(private readonly options: Options) {}
  async run(
    publicKey: string,
    signal: AbortSignal,
    onPhase: (phase: SetupPhase) => void,
  ): Promise<void> {
    if (this.running) throw new Error("Termux setup is already running");
    this.running = true;
    const { native } = this.options;
    const now = this.options.now ?? Date.now;
    const timeoutMs = this.options.timeoutMs ?? 10 * 60 * 1000;
    const deadline = now() + timeoutMs;
    const operation = new AbortController();
    let expired = false;
    const abort = () => operation.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => {
      expired = true;
      abort();
    }, timeoutMs);
    const check = () => {
      if (signal.aborted) throw cancelled();
      if (expired || now() >= deadline) throw timedOut();
    };
    const wait = async <T>(action: () => Promise<T>): Promise<T> => {
      check();
      let listener: (() => void) | undefined;
      try {
        const result = await Promise.race([
          action(),
          new Promise<never>((_, reject) => {
            listener = () => reject(signal.aborted ? cancelled() : timedOut());
            operation.signal.addEventListener("abort", listener, {
              once: true,
            });
            if (operation.signal.aborted) listener();
          }),
        ]);
        check();
        return result;
      } finally {
        if (listener) operation.signal.removeEventListener("abort", listener);
      }
    };
    const matches = (result: ProbeResult, hash: string) => {
      if (result.kind === "offline") return false;
      if (result.kind === "ready" && result.hash === hash) return true;
      const reason =
        result.kind === "incompatible"
          ? result.message
          : "different service version";
      throw new Error(
        `Termux service is incompatible (${reason}). Stop the existing Moose service in Termux and retry.`,
      );
    };
    let primaryFailure: unknown;
    let failed = false;
    try {
      if (!/^[0-9a-f]{64}$/.test(publicKey))
        throw new Error("Invalid public pairing key");
      check();
      onPhase("checking");
      const status = await wait(() => native.status());
      if (!status.installed)
        throw new Error("Install Termux before setting up the service.");
      if (!/^[0-9a-f]{64}$/.test(status.assetHash))
        throw new Error(
          "Packaged Termux service hash is unavailable. Rebuild Moose and retry.",
        );
      if (
        !matches(
          await wait(() => this.options.probe(operation.signal)),
          status.assetHash,
        )
      ) {
        if (!status.granted)
          throw new Error(
            "Grant the Termux RUN_COMMAND permission in Android settings and retry.",
          );
        onPhase("installing");
        const started = await wait(() => native.start(publicKey));
        if (started.assetHash !== status.assetHash)
          throw new Error("Packaged service changed during setup. Retry.");
        while (true) {
          const current = await wait(() => native.status());
          if (current.lastError) throw new Error(current.lastError);
          if (
            matches(
              await wait(() => this.options.probe(operation.signal)),
              status.assetHash,
            )
          )
            break;
          await wait(() =>
            (this.options.sleep ?? sleep)(
              Math.min(2000, deadline - now()),
              operation.signal,
            ),
          );
        }
      }
    } catch (error) {
      primaryFailure = error;
      failed = true;
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      operation.abort();
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Cleanup has its own deadline: the operation may already be cancelled.
        // Promise.race observes late native rejection after this deadline too.
        await Promise.race([
          Promise.resolve().then(() => native.stopBootstrap()),
          new Promise<never>((_, reject) => {
            cleanupTimer = setTimeout(
              () =>
                reject(
                  new Error(
                    "Termux bootstrap cleanup timed out. Reopen Moose and retry.",
                  ),
                ),
              5000,
            );
          }),
        ]);
      } catch (cleanupError) {
        const cleanupMessage =
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError);
        if (failed) {
          const primaryMessage =
            primaryFailure instanceof Error
              ? primaryFailure.message
              : String(primaryFailure);
          throw new Error(`${primaryMessage}; ${cleanupMessage}`, {
            cause: primaryFailure,
          });
        }
        if (signal.aborted)
          throw new Error(`${cancelled().message}; ${cleanupMessage}`, {
            cause: cleanupError,
          });
        throw cleanupError;
      } finally {
        clearTimeout(cleanupTimer);
        this.running = false;
      }
    }
    check();
    onPhase("ready");
  }
}
