import type { ContextKey } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
/** Shared across the prebundled runtime and Metro's platform adapter. */
export const executionRequestKey: ContextKey<{
  taskId: string;
  sequence: number;
}> = { token: Symbol.for("moose.execution-request.v1") };
export function executionRequestId(context: Context) {
  const request = context.value(executionRequestKey);
  return request ? `tool-${request.taskId}-${request.sequence++}` : undefined;
}
