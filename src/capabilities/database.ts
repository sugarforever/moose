import type { SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";
import { bounded, bytes, check, fail, id, type Args } from "./contracts";

export type Cell = string | number | null;
type Column = { name: string; type: string; pk: number };
export async function columns(tx: SqliteExecutor, table: string) {
  const result = await tx.all<Column>(`PRAGMA table_info(${id(table)})`);
  if (!result.length) fail("validation", "Table does not exist");
  return result;
}
export async function migrate(
  tx: SqliteExecutor,
  args: Args<"database_schema">,
  signal: AbortSignal,
) {
  const seen = new Set<string>();
  for (const table of args.tables) {
    check(signal);
    id(table.name);
    const name = table.name.toLowerCase();
    if (seen.has(name)) fail("validation", "Duplicate table");
    seen.add(name);
    const names = table.columns.map((c) => c.name.toLowerCase());
    if (
      new Set(names).size !== names.length ||
      table.columns.filter((c) => c.primaryKey).length !== 1
    )
      fail("validation", "Declare unique columns and exactly one primary key");
    for (const c of table.columns) id(c.name);
    const existing = await tx.all<Column>(
      `PRAGMA table_info(${id(table.name)})`,
    );
    if (!existing.length) {
      const count = await tx.get<{ n: number }>(
        "SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name NOT LIKE '_moose_%'",
      );
      if ((count?.n ?? 0) >= 128)
        fail("limit", "Skill database table limit reached");
      await tx.run(
        `CREATE TABLE ${id(table.name)} (${table.columns.map((c) => `${id(c.name)} ${c.type}${c.primaryKey ? " PRIMARY KEY NOT NULL" : ""}`).join(",")})`,
      );
    } else {
      for (const c of table.columns) {
        const old = existing.find(
          (x) => x.name.toLowerCase() === c.name.toLowerCase(),
        );
        if (old) {
          if (old.type !== c.type || !!old.pk !== !!c.primaryKey)
            fail(
              "validation",
              "Migration cannot change existing column type or primary key",
            );
        } else {
          if (c.primaryKey || existing.length >= 32)
            fail("validation", "Cannot add primary key or exceed 32 columns");
          await tx.run(
            `ALTER TABLE ${id(table.name)} ADD COLUMN ${id(c.name)} ${c.type}`,
          );
          existing.push({ name: c.name, type: c.type, pk: 0 });
        }
      }
    }
  }
  return { tables: args.tables.map((t) => t.name) };
}
function cell(value: unknown): Cell {
  if (value === null) return null;
  if (typeof value === "string") return bounded(value, 8192);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return fail("validation", "Expected a finite number, string or null");
}
export async function upsert(
  tx: SqliteExecutor,
  table: string,
  rows: Record<string, unknown>[],
  signal: AbortSignal,
) {
  const schema = await columns(tx, table);
  const primary = schema.find((c) => c.pk);
  if (!primary) fail("validation", "Table has no primary key");
  for (const row of rows) {
    check(signal);
    const keys = Object.keys(row);
    if (
      !keys.length ||
      keys.length > 32 ||
      !Object.hasOwn(row, primary!.name) ||
      row[primary!.name] === null
    )
      fail("validation", "Row must include non-null primary key");
    for (const key of keys)
      if (!schema.some((c) => c.name === key))
        fail("validation", "Unknown column");
    const values = keys.map((key) => cell(row[key]));
    const updates = keys.filter((k) => k !== primary!.name);
    await tx.run(
      `INSERT INTO ${id(table)} (${keys.map(id).join(",")}) VALUES (${keys.map(() => "?").join(",")}) ON CONFLICT(${id(primary!.name)}) DO ${updates.length ? `UPDATE SET ${updates.map((k) => `${id(k)}=excluded.${id(k)}`).join(",")}` : "NOTHING"}`,
      ...values,
    );
  }
  return { rows: rows.length };
}
export async function query(
  tx: SqliteExecutor,
  args: Args<"database_query">,
  signal: AbortSignal,
) {
  const schema = await columns(tx, args.table);
  const names = args.columns ?? schema.map((c) => c.name);
  const known = (name: string) => {
    if (!schema.some((c) => c.name === name))
      fail("validation", "Unknown column");
    return id(name);
  };
  const where = args.where ?? [];
  const sql = `SELECT ${names.map(known).join(",")} FROM ${id(args.table)}${where.length ? ` WHERE ${where.map((w) => `${known(w.column)} ${w.value === null ? (w.op === "=" ? "IS" : w.op === "!=" ? "IS NOT" : fail("validation", "Null supports only = or !=")) : w.op} ?`).join(" AND ")}` : ""}${args.orderBy ? ` ORDER BY ${known(args.orderBy)}${args.descending ? " DESC" : " ASC"}` : ` ORDER BY ${id(schema.find((c) => c.pk)!.name)}`}`;
  const params = where.map((w) => cell(w.value));
  const rows: object[] = [];
  let size = 0,
    truncated = false;
  const limit = args.limit ?? 100;
  for (let offset = 0; offset <= limit; offset++) {
    check(signal);
    const row = await tx.get<object>(
      `${sql} LIMIT 1 OFFSET ?`,
      ...params,
      offset,
    );
    if (!row) break;
    const length = bytes(JSON.stringify(row));
    if (offset === limit || size + length > 24 * 1024) {
      truncated = true;
      break;
    }
    rows.push(row);
    size += length;
  }
  return {
    sql: `${sql} LIMIT ?`,
    rows,
    truncated,
  };
}
export function select(value: unknown, path: (string | number)[]): unknown {
  for (const part of path) {
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, part)
    )
      return fail(
        "validation",
        `Missing JSON path component ${String(part).slice(0, 128)}`,
      );
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
export function transform(
  data: unknown,
  args: Args<"json_import">,
  signal: AbortSignal,
) {
  const source = select(data, args.select);
  if (!Array.isArray(source))
    return fail("validation", "Import selection must be an array");
  if (source.length > 50000) fail("limit", "Import exceeds 50000 rows");
  const entries = Object.entries(args.columns);
  for (const [name, m] of entries) {
    id(name);
    if (Object.hasOwn(m, "path") === Object.hasOwn(m, "constant"))
      fail("validation", "Mapping needs exactly one path or constant");
  }
  return source.map((item, index) => {
    if (index % 128 === 0) check(signal);
    return Object.fromEntries(
      entries.map(([name, m]) => {
        const value = m.path ? select(item, m.path) : m.constant;
        let converted: Cell;
        if (m.type === "null") converted = null;
        else if (m.type === "string") {
          if (!["string", "number", "boolean"].includes(typeof value))
            return fail(
              "validation",
              `Row ${index}: cannot convert ${name} to string`,
            );
          converted = bounded(String(value), 8192);
        } else if (m.type === "number") {
          if (
            (typeof value !== "number" && typeof value !== "string") ||
            (typeof value === "string" && !value.trim()) ||
            !Number.isFinite(Number(value))
          )
            return fail(
              "validation",
              `Row ${index}: cannot convert ${name} to number`,
            );
          converted = Number(value);
        } else {
          if ([true, 1, "true", "1"].includes(value as never)) converted = 1;
          else if ([false, 0, "false", "0"].includes(value as never))
            converted = 0;
          else
            return fail(
              "validation",
              `Row ${index}: cannot convert ${name} to boolean`,
            );
        }
        return [name, converted];
      }),
    );
  });
}
