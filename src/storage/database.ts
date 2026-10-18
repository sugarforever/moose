import type {
  SqliteDatabase,
  SqliteExecutor,
  SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";

export type Binding = string | number | null | Uint8Array;
export interface NativeSqlite {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: Binding[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, ...params: Binding[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: Binding[]): Promise<T[]>;
  closeAsync(): Promise<void>;
}

function bindings(params: SqliteValue[]): Binding[] {
  return params.map((value) => {
    if (typeof value !== "bigint") return value;
    const number = Number(value);
    if (!Number.isSafeInteger(number))
      throw new Error("SQLite integer exceeds safe range");
    return number;
  });
}

/** One queue for reads, writes, transactions and close; no Expo transaction leakage. */
export class SerialSqliteDatabase implements SqliteDatabase {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private readonly native: NativeSqlite) {}

  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => {
      if (this.closed) throw new Error("Database closed");
      return fn();
    });
    this.tail = result.catch(() => {});
    return result;
  }
  private executor(active: () => boolean): SqliteExecutor {
    const guard = () => {
      if (!active()) throw new Error("Transaction inactive");
    };
    return {
      exec: async (sql) => {
        guard();
        await this.native.execAsync(sql);
      },
      run: async (sql, ...params) => {
        guard();
        await this.native.runAsync(sql, ...bindings(params));
      },
      get: async <T extends object>(sql: string, ...params: SqliteValue[]) => {
        guard();
        return (
          (await this.native.getFirstAsync<T>(sql, ...bindings(params))) ??
          undefined
        );
      },
      all: async <T extends object>(sql: string, ...params: SqliteValue[]) => {
        guard();
        return this.native.getAllAsync<T>(sql, ...bindings(params));
      },
    };
  }
  exec(sql: string) {
    return this.queue(() => this.native.execAsync(sql));
  }
  run(sql: string, ...params: SqliteValue[]) {
    return this.queue(async () => {
      await this.native.runAsync(sql, ...bindings(params));
    });
  }
  get<T extends object>(sql: string, ...params: SqliteValue[]) {
    return this.queue(
      async () =>
        (await this.native.getFirstAsync<T>(sql, ...bindings(params))) ??
        undefined,
    );
  }
  all<T extends object>(sql: string, ...params: SqliteValue[]) {
    return this.queue(() =>
      this.native.getAllAsync<T>(sql, ...bindings(params)),
    );
  }
  transaction<T>(
    callback: (transaction: SqliteExecutor) => Promise<T>,
  ): Promise<T> {
    return this.queue(async () => {
      await this.native.execAsync("BEGIN IMMEDIATE");
      let active = true;
      try {
        const result = await callback(this.executor(() => active));
        active = false;
        await this.native.execAsync("COMMIT");
        return result;
      } catch (error) {
        active = false;
        try {
          await this.native.execAsync("ROLLBACK");
        } catch (rollback) {
          throw new AggregateError(
            [error, rollback],
            "Transaction rollback failed",
          );
        }
        throw error;
      }
    });
  }
  close() {
    return this.queue(async () => {
      this.closed = true;
      await this.native.closeAsync();
    });
  }
}
