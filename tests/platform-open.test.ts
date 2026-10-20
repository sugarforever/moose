import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
const state = vi.hoisted(() => ({
  failure: "factory",
  native: undefined as any,
  db: undefined as any,
}));
vi.mock("expo-sqlite", () => ({ openDatabaseAsync: async () => state.native }));
vi.mock("pi-durable-expo-env", () => ({
  createExpoWorkspace: () => ({ cleanup: async () => {} }),
}));
vi.mock("expo-secure-store", () => ({ getItemAsync: async () => null }));
vi.mock("expo/fetch", () => ({ fetch: async () => new Response("{}") }));
vi.mock("../src/platform/termux", () => ({
  termux: {
    factory: async () => {
      if (state.failure === "factory") throw new Error("factory failed");
      return undefined;
    },
  },
}));
vi.mock("../src/platform/codex", () => ({
  codexAuth: {
    status: async () => ({ connected: false }),
    getAccessToken: async () => undefined,
  },
}));
vi.mock("../src/platform/capabilities", () => ({
  approvals: { request: async () => false },
  openCapabilityDatabase: async () => {
    throw new Error("unused");
  },
}));
import { openMobile } from "../src/platform/open";
afterEach(() => {
  if (state.db?.isOpen) state.db.close();
});
for (const failure of ["factory", "settings"])
  it(`closes the real SQLite owner when ${failure} initialization fails`, async () => {
    state.failure = failure;
    const db = (state.db = new DatabaseSync(":memory:"));
    state.native = {
      execAsync: async (sql: string) => db.exec(sql),
      runAsync: async (sql: string, ...p: any[]) => {
        db.prepare(sql).run(...p);
      },
      getFirstAsync: async (sql: string, ...p: any[]) => {
        if (state.failure === "settings" && p[0] === "settings")
          throw new Error("settings failed");
        return db.prepare(sql).get(...p) ?? null;
      },
      getAllAsync: async (sql: string, ...p: any[]) =>
        db.prepare(sql).all(...p),
      closeAsync: async () => db.close(),
    };
    await expect(openMobile()).rejects.toThrow(failure + " failed");
    expect(db.isOpen).toBe(false);
  });
