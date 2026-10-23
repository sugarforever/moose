import type { ExecutionStatus } from "./execution-diagnostics";

type Snapshot = { revision: string; status: ExecutionStatus };
type Item = { id: number; status: ExecutionStatus };
/** Observes admitted work only. It neither submits nor resumes tasks. */
export class ExecutionNotifications {
  private items = new Map<
    number,
    { count: number; baseline: string; status: ExecutionStatus; detach(): void }
  >();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private io: {
      read(id: number): Promise<Snapshot>;
      watch(
        id: number,
        listener: (view: Snapshot) => void,
      ): Promise<() => void>;
      progress(items: Item[]): void;
      result(id: number, status: ExecutionStatus): void | Promise<void>;
    },
  ) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation);
    this.tail = next.catch(() => {});
    return next;
  }
  private publish() {
    try {
      this.io.progress(
        [...this.items].map(([id, item]) => ({ id, status: item.status })),
      );
    } catch {
      /* Notifications are best effort; execution and cleanup still proceed. */
    }
  }
  track(ids: readonly number[]): Promise<() => Promise<void>> {
    return this.serial(async () => {
      const tracked: number[] = [];
      for (const id of new Set(ids)) {
        const existing = this.items.get(id);
        if (existing) {
          existing.count++;
          tracked.push(id);
          continue;
        }
        try {
          const baseline = await this.io.read(id);
          const item = {
            count: 1,
            baseline: baseline.revision,
            status: { state: "running", retries: 0 } as ExecutionStatus,
            detach: () => {},
          };
          this.items.set(id, item);
          item.detach = await this.io.watch(id, (view) => {
            if (this.items.get(id) !== item) return;
            if (
              [
                "running",
                "retrying",
                "waiting_network",
                "waiting_authorization",
              ].includes(view.status.state) &&
              view.revision !== item.baseline
            ) {
              item.status = view.status;
              this.publish();
            }
          });
          tracked.push(id);
        } catch {
          this.items.delete(id);
        }
      }
      this.publish();
      let finished = false;
      return () =>
        this.serial(async () => {
          if (finished) return;
          finished = true;
          for (const id of tracked) {
            const item = this.items.get(id)!;
            if (--item.count) continue;
            try {
              const final = await this.io.read(id);
              if (
                final.revision !== item.baseline &&
                ["completed", "failed", "waiting_authorization"].includes(
                  final.status.state,
                )
              ) {
                await this.io.result(
                  id,
                  final.status.state === "waiting_authorization"
                    ? { ...final.status, state: "failed" }
                    : final.status,
                );
              }
            } catch {
              /* One failed read/delivery must not orphan other conversations. */
            } finally {
              this.items.delete(id);
              try {
                item.detach();
              } catch {
                /* Continue releasing every observer. */
              }
            }
          }
          this.publish();
        });
    });
  }
}
/** Never echo provider bodies, URLs, headers or user text onto the lock screen. */
export function notificationFailure(reason = ""): string {
  if (/401|403|unauthori[sz]ed|sign.in|API key|session.*expired/i.test(reason))
    return "Sign in or check your credentials.";
  if (/network|connection|fetch|socket|timed? ?out/i.test(reason))
    return "Network request failed.";
  if (/429|quota|rate.limit/i.test(reason))
    return "Provider usage limit reached.";
  return "Task failed. Open Moose for details.";
}
