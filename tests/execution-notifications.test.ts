import { expect, it } from "vitest";
import {
  ExecutionNotifications,
  notificationFailure,
} from "../src/runtime/execution-notifications";
import type { ExecutionStatus } from "../src/runtime/execution-diagnostics";

type Snapshot = { revision: string; status: ExecutionStatus };
function fixture() {
  const views = new Map<number, Snapshot>([
    [1, { revision: "old", status: { state: "failed", retries: 0 } }],
  ]);
  const listeners = new Map<number, (view: Snapshot) => void>();
  const progress: unknown[] = [],
    results: unknown[] = [];
  const notifications = new ExecutionNotifications({
    read: async (id) => views.get(id)!,
    watch: async (id, listener) => {
      listeners.set(id, listener);
      listener(views.get(id)!);
      return () => {
        listeners.delete(id);
      };
    },
    progress: (items) => {
      progress.push(items);
    },
    result: (id, status) => {
      results.push({ id, status });
    },
  });
  return { notifications, views, listeners, progress, results };
}
it("does not alert on an unchanged historical failure or cancellation", async () => {
  const f = fixture();
  const finish = await f.notifications.track([1]);
  await finish();
  expect(f.results).toEqual([]);
  const cancelled = await f.notifications.track([1]);
  f.views.set(1, {
    revision: "cancel",
    status: { state: "cancelled", retries: 0 },
  });
  await cancelled();
  expect(f.results).toEqual([]);
});
it("reads the committed final result before publishing and deduplicates overlapping leases", async () => {
  const f = fixture();
  const first = await f.notifications.track([1]);
  const second = await f.notifications.track([1]);
  f.listeners.get(1)!({
    revision: "retry",
    status: { state: "waiting_network", retries: 1 },
  });
  expect(f.progress.at(-1)).toEqual([
    { id: 1, status: { state: "waiting_network", retries: 1 } },
  ]);
  await first();
  expect(f.results).toEqual([]);
  // No final watch delivery: release must read SQLite, not reuse the last callback.
  f.views.set(1, {
    revision: "committed",
    status: { state: "completed", retries: 1 },
  });
  await second();
  await second();
  expect(f.results).toEqual([
    { id: 1, status: { state: "completed", retries: 1 } },
  ]);
  expect(f.progress.at(-1)).toEqual([]);
  expect(f.listeners.size).toBe(0);
});
it("keeps concurrent conversations distinct and emits a final authorization error as failure", async () => {
  const f = fixture();
  f.views.set(2, { revision: "empty", status: { state: "idle", retries: 0 } });
  const finish = await f.notifications.track([1, 2]);
  expect(f.progress.at(-1)).toEqual([
    { id: 1, status: { state: "running", retries: 0 } },
    { id: 2, status: { state: "running", retries: 0 } },
  ]);
  f.views.set(2, {
    revision: "new",
    status: {
      state: "waiting_authorization",
      retries: 0,
      reason: "401 secret",
    },
  });
  await finish();
  expect(f.results).toEqual([
    { id: 2, status: { state: "failed", retries: 0, reason: "401 secret" } },
  ]);
});
it("notification failures use fixed categories and never echo arbitrary credentials", () => {
  expect(notificationFailure("401 Bearer hidden")).toBe(
    "Sign in or check your credentials.",
  );
  expect(notificationFailure("Network error sk-private")).toBe(
    "Network request failed.",
  );
  expect(notificationFailure("secret access_token=unusual-token")).toBe(
    "Task failed. Open Moose for details.",
  );
});

it("cleans every conversation after a final read or delivery fails", async () => {
  const f = fixture();
  f.views.set(2, { revision: "old", status: { state: "idle", retries: 0 } });
  const finish = await f.notifications.track([1, 2]);
  f.views.delete(1); // Final read fails when its missing snapshot is consumed.
  f.views.set(2, {
    revision: "new",
    status: { state: "completed", retries: 0 },
  });
  await finish();
  expect(f.listeners.size).toBe(0);
  expect(f.results).toEqual([
    { id: 2, status: { state: "completed", retries: 0 } },
  ]);
  expect(f.progress.at(-1)).toEqual([]);
});
it("a partial admission read failure does not orphan earlier watchers", async () => {
  const f = fixture();
  const finish = await f.notifications.track([1, 99]);
  await finish();
  expect(f.listeners.size).toBe(0);
  const next = await f.notifications.track([1]);
  f.views.set(1, {
    revision: "new",
    status: { state: "completed", retries: 0 },
  });
  await next();
  expect(f.results).toHaveLength(1);
});
