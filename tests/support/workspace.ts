import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  SerialSqliteDatabase,
  type NativeSqlite,
} from "../../src/storage/database";
import type { WorkspaceBackend } from "pi-durable-expo-env/core";
export function database(path: string) {
  const db = new DatabaseSync(path);
  return new SerialSqliteDatabase({
    execAsync: async (sql) => {
      db.exec(sql);
    },
    runAsync: async (sql, ...args) => {
      db.prepare(sql).run(...args);
    },
    getFirstAsync: async (sql, ...args) =>
      (db.prepare(sql).get(...args) as never) ?? null,
    getAllAsync: async (sql, ...args) => db.prepare(sql).all(...args) as never,
    closeAsync: async () => db.close(),
  } satisfies NativeSqlite);
}
export const backend: WorkspaceBackend = {
  async stat(uri) {
    try {
      const s = await fs.stat(fileURLToPath(uri));
      return {
        kind: s.isDirectory() ? "directory" : "file",
        size: s.size,
        mtimeMs: s.mtimeMs,
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  },
  async read(uri, limit, signal) {
    signal.throwIfAborted();
    const h = await fs.open(fileURLToPath(uri), "r");
    try {
      const data = new Uint8Array(limit + 1);
      const { bytesRead } = await h.read(data);
      if (bytesRead > limit) throw new Error("Size limit");
      return data.slice(0, bytesRead);
    } finally {
      await h.close();
    }
  },
  async write(uri, data) {
    await fs.writeFile(fileURLToPath(uri), data);
  },
  async mkdir(uri, recursive) {
    await fs.mkdir(fileURLToPath(uri), { recursive });
  },
  async names(uri) {
    return fs.readdir(fileURLToPath(uri));
  },
  async remove(uri, recursive) {
    await fs.rm(fileURLToPath(uri), { recursive });
  },
  async move(a, b) {
    await fs.rename(fileURLToPath(a), fileURLToPath(b));
  },
};
