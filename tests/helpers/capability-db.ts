import { DatabaseSync } from "node:sqlite";
import { SerialSqliteDatabase } from "../../src/storage/database";
export function sqlite(path: string) {
  const db = new DatabaseSync(path);
  return new SerialSqliteDatabase({
    execAsync: async (sql) => {
      db.exec(sql);
    },
    runAsync: async (sql, ...p) => {
      db.prepare(sql).run(...p);
    },
    getFirstAsync: async (sql, ...p) =>
      (db.prepare(sql).get(...p) as never) ?? null,
    getAllAsync: async (sql, ...p) => db.prepare(sql).all(...p) as never,
    closeAsync: async () => db.close(),
  });
}
