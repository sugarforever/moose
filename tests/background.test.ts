import { expect, it } from "vitest";
import { ExecutionOwner, RuntimeOwner } from "../src/runtime/execution-owner";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
it("shares initialization, survives UI releases, and retries failed open", async () => {
  let opens = 0;
  const opening = deferred<{ value: number }>();
  const owner = new RuntimeOwner(async () => {
    opens++;
    return opening.promise;
  });
  const a = owner.get();
  const b = owner.get();
  opening.resolve({ value: 42 });
  expect(await a).toBe(await b);
  expect(await owner.get()).toBe(await a);
  expect(opens).toBe(1);
  let attempts = 0;
  const retry = new RuntimeOwner(async () => {
    if (++attempts === 1) throw new Error("open");
    return 1;
  });
  await expect(retry.get()).rejects.toThrow("open");
  expect(await retry.get()).toBe(1);
});
it("does not execute before shared service handshake; last lease releases it", async () => {
  const ready = deferred();
  const starts: string[] = [];
  const stops: string[] = [];
  const owner = new ExecutionOwner(
    {
      start: async (token) => {
        starts.push(token);
        await ready.promise;
      },
      stop: async (token) => {
        stops.push(token);
      },
    },
    async () => {},
  );
  let entered = 0;
  const a = owner.acquire().then((x) => {
    entered++;
    return x;
  });
  const b = owner.acquire().then((x) => {
    entered++;
    return x;
  });
  await Promise.resolve();
  expect(entered).toBe(0);
  expect(starts.length).toBe(1);
  ready.resolve();
  const [first, second] = await Promise.all([a, b]);
  await first.release();
  expect(stops).toEqual([]);
  await second.release();
  expect(stops).toEqual(starts);
  const third = await owner.acquire();
  await first.release();
  expect(stops.length).toBe(1);
  await third.release();
  expect(stops.length).toBe(2);
});
it("cancels pending admission on native stop and fences new work until cancellation commits", async () => {
  const ready = deferred();
  const cancelled = deferred();
  const owner = new ExecutionOwner(
    { start: async () => ready.promise, stop: async () => {} },
    () => cancelled.promise,
  );
  const admission = owner.acquire();
  const rejected = expect(admission).rejects.toThrow();
  const stopping = owner.cancel();
  ready.resolve();
  await rejected;
  await expect(owner.acquire()).rejects.toThrow();
  cancelled.resolve();
  await stopping;
  const lease = await owner.acquire();
  expect(lease.signal.aborted).toBe(false);
  await lease.release();
});
it("failed startup cleans the session and permits retry without executing", async () => {
  let fail = true;
  let stops = 0;
  const owner = new ExecutionOwner(
    {
      start: async () => {
        if (fail) throw new Error("denied");
      },
      stop: async () => {
        stops++;
      },
    },
    async () => {},
  );
  await expect(owner.acquire()).rejects.toThrow("denied");
  fail = false;
  const lease = await owner.acquire();
  await lease.release();
  expect(stops).toBe(2);
});

it("shares an exclusive runtime replacement with newly mounted views", async () => {
  const owner = new RuntimeOwner(async () => "old");
  await owner.get();
  const ready = deferred<string>();
  const change = owner.replace(async () => ready.promise);
  const mounted = owner.get();
  await expect(owner.replace(async () => "other")).rejects.toThrow(
    "in progress",
  );
  ready.resolve("new");
  expect(await change).toBe("new");
  expect(await mounted).toBe("new");
  await expect(
    owner.replace(async () => {
      throw new Error("busy");
    }),
  ).rejects.toThrow("busy");
  expect(await owner.get()).toBe("new");
});

it("waits for native shutdown before admitting a new generation", async () => {
  const stopped = deferred();
  let starts = 0;
  const owner = new ExecutionOwner(
    {
      start: async () => {
        starts++;
      },
      stop: async () => stopped.promise,
    },
    async () => {},
  );
  const old = await owner.acquire();
  const releasing = old.release();
  const next = owner.acquire();
  await Promise.resolve();
  await Promise.resolve();
  expect(starts).toBe(1);
  stopped.resolve();
  await releasing;
  const lease = await next;
  expect(starts).toBe(2);
  await lease.release();
});
