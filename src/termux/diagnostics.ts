import { fileMethods } from "./wire";
export type RequestResult =
  | "stage"
  | "ok"
  | "file_error"
  | "shell_error"
  | "cancelled"
  | "timeout"
  | "network"
  | "rejected"
  | "protocol"
  | "service";
export type RequestDiagnostic = {
  op: string;
  result: RequestResult;
  elapsedMs: number;
  code?: string;
};
const errorCodes = new Set([
  "aborted",
  "not_found",
  "permission_denied",
  "not_directory",
  "is_directory",
  "invalid",
  "not_supported",
  "unknown",
  "timeout",
  "shell_unavailable",
  "spawn_error",
  "callback_error",
]);
const operations = new Set<string>([
  ...fileMethods,
  "connect",
  "serviceInfo",
  "handle",
  "exec",
  "poll",
  "cancel",
  "ack",
  "cleanup",
  "setup.checking",
  "setup.installing",
  "setup.connecting",
  "setup.ready",
]);
type Snapshot = {
  connection: "unknown" | "available" | "unavailable";
  checkedAt?: number;
  records: readonly (RequestDiagnostic & { at: number; id: number })[];
};
/** Session-only metadata. Never accepts request arguments, identifiers or error messages. */
export class TermuxDiagnostics {
  private value: Snapshot = { connection: "unknown", records: [] };
  private nextId = 0;
  private listeners = new Set<() => void>();
  snapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  record = ({ op, result, elapsedMs, code }: RequestDiagnostic) => {
    const at = Date.now();
    const cancelled = result === "cancelled" || result === "stage";
    this.value = {
      connection: cancelled
        ? this.value.connection
        : result === "ok" ||
            result === "file_error" ||
            result === "shell_error" ||
            result === "service"
          ? "available"
          : "unavailable",
      checkedAt: cancelled ? this.value.checkedAt : at,
      records: [
        ...this.value.records,
        {
          at,
          id: ++this.nextId,
          op: operations.has(op) ? op : "unknown",
          result,
          ...(code && errorCodes.has(code) ? { code } : {}),
          elapsedMs: Math.max(0, Math.round(elapsedMs)),
        },
      ].slice(-40),
    };
    for (const listener of this.listeners) listener();
  };
  export = () =>
    this.value.records
      .map(
        (r) =>
          `${new Date(r.at).toISOString()} #${r.id} ${r.op} ${r.result}${r.code ? `:${r.code}` : ""} ${r.elapsedMs}ms`,
      )
      .join("\n");
}
export const termuxDiagnostics = new TermuxDiagnostics();
