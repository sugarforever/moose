import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  SerialSqliteDatabase,
  type NativeSqlite,
} from "../src/storage/database";

export function memoryDatabase() {
  const db = new DatabaseSync(":memory:");
  const native: NativeSqlite = {
    execAsync: async (sql) => {
      db.exec(sql);
    },
    runAsync: async (sql, ...params) => {
      db.prepare(sql).run(...params);
    },
    getFirstAsync: async (sql, ...params) =>
      (db.prepare(sql).get(...params) ?? null) as never,
    getAllAsync: async (sql, ...params) =>
      db.prepare(sql).all(...params) as never,
    closeAsync: async () => db.close(),
  };
  return { database: new SerialSqliteDatabase(native), native };
}

describe("SQLite isolation", () => {
  it("rolls back writes and rejects escaped transaction handles", async () => {
    const { database } = memoryDatabase();
    await database.exec("CREATE TABLE test (value INTEGER)");
    let escaped:
      Parameters<Parameters<typeof database.transaction>[0]>[0] | undefined;
    await expect(
      database.transaction(async (tx) => {
        escaped = tx;
        await tx.run("INSERT INTO test VALUES (?)", 1);
        throw new Error("interrupted");
      }),
    ).rejects.toThrow("interrupted");
    expect(await database.all("SELECT * FROM test")).toEqual([]);
    await expect(escaped!.run("INSERT INTO test VALUES (2)")).rejects.toThrow(
      "inactive",
    );
    await database.close();
  });

  it("holds concurrent writes until a transaction commits", async () => {
    const { database } = memoryDatabase();
    await database.exec("CREATE TABLE test (value INTEGER)");
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const first = database.transaction(async (tx) => {
      await tx.run("INSERT INTO test VALUES (1)");
      started.resolve();
      await gate.promise;
      await tx.run("INSERT INTO test VALUES (2)");
    });
    await started.promise;
    const later = database.run("INSERT INTO test VALUES (3)");
    gate.resolve();
    await Promise.all([first, later]);
    expect(await database.all("SELECT value FROM test ORDER BY rowid")).toEqual(
      [{ value: 1 }, { value: 2 }, { value: 3 }],
    );
    await database.close();
  });
});
