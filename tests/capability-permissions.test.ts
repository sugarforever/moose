import { expect, it } from "vitest";
import { PermissionStore } from "../src/capabilities/permissions";
import { sqlite } from "./helpers/capability-db";
it("persists exact grants, scopes them per conversation and revokes them", async () => {
  const db = sqlite(":memory:");
  let prompts = 0;
  const store = await PermissionStore.open(db, async () => {
    prompts++;
    return true;
  });
  const signal = new AbortController().signal;
  expect(
    await store.authorize(1, "skill", "http:https://example.com", signal),
  ).toBe(true);
  expect(
    await store.authorize(1, "skill", "http:https://example.com", signal),
  ).toBe(true);
  expect(prompts).toBe(1);
  expect(
    await store.authorize(2, "skill", "http:https://example.com", signal),
  ).toBe(true);
  await store.revoke(1);
  expect(await store.list(1)).toEqual([]);
  expect(await store.list(2)).toHaveLength(1);
  await db.close();
});
it("does not grant after cancellation or revocation while a prompt is pending", async () => {
  const db = sqlite(":memory:");
  let finish!: (allow: boolean) => void;
  let started!: () => void;
  const start = new Promise<void>((r) => (started = r));
  const store = await PermissionStore.open(db, async () => {
    started();
    return new Promise<boolean>((r) => (finish = r));
  });
  const controller = new AbortController();
  const pending = store.authorize(
    1,
    "skill",
    "database:write",
    controller.signal,
  );
  await start;
  controller.abort();
  finish(true);
  expect(await pending).toBe(false);
  expect(await store.list(1)).toEqual([]);
  await db.close();
});
