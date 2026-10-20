import { Type, type Static } from "typebox";

const text = (maxLength = 512) => Type.String({ minLength: 1, maxLength });
const identifier = Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_]{0,62}$" });
const scalar = Type.Union([
  Type.String({ maxLength: 8192 }),
  Type.Number(),
  Type.Null(),
]);
const path = Type.Array(
  Type.Union([
    Type.String({ maxLength: 128 }),
    Type.Integer({ minimum: 0, maximum: 50000 }),
  ]),
  { maxItems: 16 },
);
const column = Type.Object(
  {
    name: identifier,
    type: Type.Union([
      Type.Literal("TEXT"),
      Type.Literal("INTEGER"),
      Type.Literal("REAL"),
    ]),
    primaryKey: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
const row = Type.Record(identifier, scalar, {
  minProperties: 1,
  maxProperties: 32,
});
const mapping = Type.Object(
  {
    path: Type.Optional(path),
    constant: Type.Optional(Type.Union([scalar, Type.Boolean()])),
    type: Type.Union([
      Type.Literal("string"),
      Type.Literal("number"),
      Type.Literal("boolean"),
      Type.Literal("null"),
    ]),
  },
  { additionalProperties: false },
);
const common = { skillId: text(2048) };
const operation = { operationId: text(128) };
const object = <T extends Record<string, import("typebox").TSchema>>(p: T) =>
  Type.Object({ ...common, ...p }, { additionalProperties: false });
export const schemas = {
  http_request: object({ url: text(4096) }),
  database_inspect: object({ table: Type.Optional(identifier) }),
  database_schema: object({
    ...operation,
    tables: Type.Array(
      Type.Object(
        {
          name: identifier,
          columns: Type.Array(column, { minItems: 1, maxItems: 32 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 32 },
    ),
  }),
  database_query: object({
    table: identifier,
    columns: Type.Optional(
      Type.Array(identifier, { minItems: 1, maxItems: 32 }),
    ),
    where: Type.Optional(
      Type.Array(
        Type.Object(
          {
            column: identifier,
            op: Type.Union(
              ["=", "!=", "<", ">", "<=", ">="].map((x) => Type.Literal(x)),
            ),
            value: scalar,
          },
          { additionalProperties: false },
        ),
        { maxItems: 16 },
      ),
    ),
    orderBy: Type.Optional(identifier),
    descending: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  }),
  database_write: object({
    ...operation,
    table: identifier,
    rows: Type.Array(row, { minItems: 1, maxItems: 1000 }),
  }),
  json_import: object({
    ...operation,
    table: identifier,
    bodyRef: text(128),
    select: path,
    columns: Type.Record(identifier, mapping, {
      minProperties: 1,
      maxProperties: 32,
    }),
  }),
  document_list: object({
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })),
  }),
  document_read: object({
    name: text(128),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 512 * 1024 })),
  }),
  document_write: object({
    ...operation,
    name: text(128),
    text: Type.String({ maxLength: 512 * 1024 }),
  }),
  document_edit: object({
    ...operation,
    name: text(128),
    oldText: text(512 * 1024),
    newText: Type.String({ maxLength: 512 * 1024 }),
  }),
  artifact_create: object({
    ...operation,
    title: text(128),
    text: Type.String({ maxLength: 512 * 1024 }),
    mime: Type.Union([Type.Literal("text/html"), Type.Literal("text/plain")]),
  }),
  skill_resource_read: object({
    path: text(512),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 128 * 1024 })),
  }),
} as const;
export type ToolName = keyof typeof schemas;
export type Args<N extends ToolName> = Static<(typeof schemas)[N]>;
export const descriptions: Record<ToolName, string> = {
  http_request:
    "GET an approved HTTPS URL. Returns status, safe headers, an immutable bodyRef and a short excerpt; use json_import for large JSON. No credentials are attached.",
  database_inspect:
    "List this enabled skill's tables, or supply table to inspect its columns, in separate persistent SQLite schema and successful import timestamps. Requires a database read grant.",
  database_schema:
    "Initialize or migrate skill tables by creating tables or adding columns transactionally. Declare exactly one primary key per table. Stable operationId makes replay safe.",
  database_query:
    "Run a bounded parameterized SELECT in the skill database. Specify table, columns, comparisons, ordering and limit (max 200). Returns generated SQL and rows. No arbitrary SQL.",
  database_write:
    "Transactionally upsert rows by the declared primary key. Use a stable operationId; reusing it with different arguments fails.",
  json_import:
    "Map an array in a stored HTTP body to SQLite rows and upsert atomically. Paths select properties/array indexes; fields use a path OR constant and explicit scalar conversion. Max 50000 rows. Stable operationId replays the committed receipt.",
  document_list:
    "Enumerate this skill's user-owned shared documents. Documents survive app restart, new conversations and checkpoint branches; a per-conversation shared-documents grant is required.",
  document_read:
    "Read a named skill-shared document. Text enters model context. Shared scope requires user approval.",
  document_write:
    "Save a skill-shared document (max 512 KiB). Use a stable operationId for safe replay; other approved conversations can reopen it.",
  document_edit:
    "Replace exactly one occurrence in a skill-shared document atomically. Use a stable operationId.",
  artifact_create:
    "Persist immutable HTML/text (max 512 KiB) and return an artifact reference. User opens the conversation artifact list to preview/share; this tool never shares automatically.",
  skill_resource_read:
    "Read an enabled skill's installed SKILL.md or a relative .md/.txt/.json/.html/.csv template/reference. Remote text needs an origin grant and is cached; no scripts execute.",
};
export class CapabilityError extends Error {
  constructor(
    readonly code:
      | "permission"
      | "validation"
      | "transport"
      | "database"
      | "cancelled"
      | "limit",
    message: string,
  ) {
    super(message);
  }
}
export const fail = (code: CapabilityError["code"], message: string): never => {
  throw new CapabilityError(code, message);
};
export const bytes = (s: string) => new TextEncoder().encode(s).length;
export function bounded(s: string, max: number) {
  if (bytes(s) > max) fail("limit", `Content exceeds ${max} bytes`);
  return s;
}
export function id(s: string) {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(s) || /^sqlite_/i.test(s))
    fail("validation", "Invalid or reserved identifier");
  return `"${s}"`;
}
export const check = (signal: AbortSignal) => {
  if (signal.aborted) fail("cancelled", "Operation cancelled");
};
