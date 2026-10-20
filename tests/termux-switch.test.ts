import { expect, it } from "vitest";
import { replaceRuntime } from "../src/termux/switch";
it("closes old storage before opening a replacement and rolls back failed selection", async () => {
  const events: string[] = [];
  const result = await replaceRuntime({
    current: "old",
    assertIdle: async () => {
      events.push("idle");
    },
    select: async () => {
      events.push("select");
    },
    close: async (value) => {
      events.push("close:" + value);
    },
    open: async () => {
      events.push("open");
      throw new Error("new runtime failed");
    },
    restore: async () => {
      events.push("restore");
    },
    reopen: async () => {
      events.push("reopen");
      return "restored";
    },
  });
  expect(result).toMatchObject({
    runtime: "restored",
    error: { message: "new runtime failed" },
  });
  expect(events).toEqual([
    "idle",
    "select",
    "idle",
    "close:old",
    "open",
    "restore",
    "reopen",
  ]);
});
it("does not close a working runtime when setup is cancelled or idle check fails", async () => {
  let closed = false;
  await expect(
    replaceRuntime({
      current: "old",
      assertIdle: async () => {},
      select: async () => {
        throw new Error("cancelled");
      },
      close: async () => {
        closed = true;
      },
      open: async () => "new",
      restore: async () => {},
      reopen: async () => "old",
    }),
  ).rejects.toThrow("cancelled");
  expect(closed).toBe(false);
});
