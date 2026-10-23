import { expect, it, vi } from "vitest";
import { readyExecution } from "../src/termux/recovery";
it.each(["caller", "lease"])(
  "cancels recovery on %s cancellation and releases the execution lease",
  async (source) => {
    const caller = new AbortController();
    const lease = new AbortController();
    let released = 0;
    let checking = false;
    const acquire = readyExecution(
      async () => ({
        signal: lease.signal,
        release: async () => {
          released++;
        },
      }),
      async (signal) => {
        checking = true;
        await new Promise<void>((_, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          ),
        );
      },
    );
    const pending = acquire(caller.signal);
    await vi.waitFor(() => expect(checking).toBe(true));
    (source === "caller" ? caller : lease).abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(released).toBe(1);
  },
);
it("rejects failed service admission before handing a lease to the engine", async () => {
  let released = 0;
  const acquire = readyExecution(
    async () => ({
      signal: new AbortController().signal,
      release: async () => {
        released++;
      },
    }),
    async () => {
      throw new Error("offline");
    },
  );
  await expect(acquire()).rejects.toThrow("offline");
  expect(released).toBe(1);
});

it("checks on foreground return, cancels hidden checks, and detaches cleanly", async () => {
  let listener!: (state: string) => void;
  let removed = false;
  const signals: AbortSignal[] = [];
  const errors: unknown[] = [];
  const { observeTermuxRecovery } = await import("../src/termux/recovery");
  const stop = observeTermuxRecovery(
    {
      currentState: "active",
      addEventListener: (_event, next) => {
        listener = next;
        return {
          remove: () => {
            removed = true;
          },
        };
      },
    },
    async (signal) => {
      signals.push(signal);
      await new Promise<void>((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        }),
      );
    },
    (error) => errors.push(error),
  );
  expect(signals).toHaveLength(1);
  listener("background");
  expect(signals[0].aborted).toBe(true);
  listener("active");
  expect(signals).toHaveLength(2);
  stop();
  await Promise.resolve();
  expect(signals[1].aborted).toBe(true);
  expect(removed).toBe(true);
  expect(errors).toEqual([]);
});
