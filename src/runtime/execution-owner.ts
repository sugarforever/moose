/** Process-lifetime ownership; React views never own or close the runtime. */
export class RuntimeOwner<T> {
  private opening?: Promise<T>;
  constructor(private open: () => Promise<T>) {}
  private changing = false;
  replace(change: (current: T) => Promise<T>): Promise<T> {
    if (this.changing)
      return Promise.reject(new Error("Runtime replacement is in progress"));
    const previous = this.get();
    this.changing = true;
    const next = previous.then(change);
    this.opening = next.catch((error) => {
      this.opening = previous;
      throw error;
    });
    return this.opening.finally(() => {
      this.changing = false;
    });
  }
  invalidate() {
    this.opening = undefined;
  }
  get(): Promise<T> {
    return (this.opening ??= this.open().catch((error) => {
      this.opening = undefined;
      throw error;
    }));
  }
}
export type ExecutionLease = { signal: AbortSignal; release(): Promise<void> };
export type ExecutionGuard = (signal?: AbortSignal) => Promise<ExecutionLease>;
type Session = {
  token: string;
  controller: AbortController;
  count: number;
  ready: Promise<void>;
  done: Promise<void>;
  finish(): void;
  closing?: Promise<void>;
};
/** One native service generation shared by every admitted conversation. */
export class ExecutionOwner {
  private session?: Session;
  private stopping?: Promise<void>;
  private serial = 0;
  private closing?: Promise<void>;
  constructor(
    private native: {
      start(token: string, signal: AbortSignal): Promise<void>;
      stop(token: string): Promise<void>;
    },
    private cancelRuns: () => Promise<void>,
  ) {}
  get active() {
    return !!this.session && !this.stopping;
  }
  get busy() {
    return !!this.session || !!this.closing || !!this.stopping;
  }
  private closeSession(current: Session): Promise<void> {
    if (current.closing) return current.closing;
    if (this.session === current) this.session = undefined;
    current.finish();
    const operation = (this.closing ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.native.stop(current.token));
    const tracked = operation.finally(() => {
      if (this.closing === tracked) this.closing = undefined;
    });
    this.closing = tracked;
    return (current.closing = tracked);
  }
  async acquire(): Promise<ExecutionLease> {
    while (this.closing) await this.closing;
    if (this.stopping)
      throw new Error("Background tasks are stopping. Try again shortly.");
    let session = this.session;
    if (!session) {
      let finish!: () => void;
      session = {
        token: `${Date.now()}-${++this.serial}`,
        controller: new AbortController(),
        count: 0,
        ready: Promise.resolve(),
        done: new Promise<void>((resolve) => {
          finish = resolve;
        }),
        finish: () => finish(),
      };
      this.session = session;
      session.ready = this.native.start(
        session.token,
        session.controller.signal,
      );
    }
    const current = session;
    current.count++;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      if (--current.count === 0) {
        await this.closeSession(current);
      }
    };
    try {
      await current.ready;
      if (current.controller.signal.aborted)
        throw new Error("Background tasks stopped");
      return { signal: current.controller.signal, release };
    } catch (error) {
      await release();
      throw error;
    }
  }
  /** Headless JS must attach to the very session opened in this JS runtime. */
  attach(token: string): Promise<void> {
    if (!this.session || this.session.token !== token)
      throw new Error("Runtime owner mismatch");
    return this.session.done;
  }
  cancel(): Promise<void> {
    if (this.stopping) return this.stopping;
    const current = this.session;
    current?.controller.abort();
    this.stopping = (async () => {
      try {
        await this.cancelRuns();
      } finally {
        if (current) await this.closeSession(current);
      }
    })().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }
}
