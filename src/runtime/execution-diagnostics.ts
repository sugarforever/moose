import {
  defineDoc,
  defineExtension,
  hook,
  GenerationTask,
  ToolTask,
  LiveDoc,
  type Harness,
  type ConversationId,
  type ConversationView,
  type LiveState,
} from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

export type Cancellation = { reason: string; at: number };
export type ExecutionEvent = {
  kind: "request" | "response" | "cancel" | "restart";
  taskId: string;
  runId?: string;
  phase: string;
  at: number;
  attempt: number;
  reason: string;
  message?: string;
  responseAt?: number;
};
export const ExecutionDoc = defineDoc({
  kind: "moose.execution",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    events: [] as ExecutionEvent[],
    unknown: false as boolean,
    acknowledgedThrough: 0,
    unknownThrough: 0,
  }),
});
/** Keep diagnostics useful without copying URLs, headers, credentials or huge server bodies. */
export function safeError(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"<>]+/gi, "[URL]")
    .replace(/Bearer\s+[^\s,;"}]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[\w-]+/g, "[redacted]")
    .replace(
      /(["']?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      "$1[redacted]",
    )
    .slice(0, 2000);
}
/** Native stream errors that the pinned provider retry classifier does not recognize. */
export function modelError(value: string): string {
  const text = safeError(value);
  return /Software caused connection abort|Network request failed|ECONNRESET|ENETUNREACH|EHOSTUNREACH|Unable to resolve host|Failed to connect to|Socket closed/i.test(
    text,
  )
    ? `Network error: ${text}`.slice(0, 2000)
    : text;
}
export function executionPhase(live?: LiveState): string {
  return live?.tools?.some((tool) => tool.status !== "done")
    ? "tool"
    : live?.generation?.retry
      ? "backoff"
      : "generation";
}
export async function recordExecution(
  harness: Harness,
  id: ConversationId,
  event: ExecutionEvent,
  captureUnknown = false,
) {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(ExecutionDoc, id);
    if (captureUnknown) {
      const live = await tx.doc(LiveDoc, id);
      if (
        [...(live.tools ?? []), ...(live.nestedTools ?? [])].some(
          (tool) =>
            tool.status === "running" &&
            ["bash", "write", "edit"].includes(tool.name),
        )
      ) {
        const latest = (await tx.scanEntries({ conversationId: id }, 1))
          .items[0];
        doc.unknownThrough = Math.max(
          doc.unknownThrough ?? 0,
          Number(latest?.id ?? 0),
        );
        doc.unknown = true;
      }
    }
    doc.events.push(event);
    if (doc.events.length > 200) doc.events.splice(0, doc.events.length - 200);
  }, BACKGROUND_CONTEXT);
}
export function hasUnknownEffect(
  messages: readonly (
    | Message
    | { role: string; content?: unknown; diagnostics?: { code: string }[] }
  )[],
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user") return false;
    if (
      message.role === "toolResult" &&
      (("diagnostics" in message &&
        message.diagnostics?.some((d) => d.code === "interrupted")) ||
        /<harness>[\s\S]*(may have partially run|outcome (?:may be )?unknown)/.test(
          JSON.stringify(message.content),
        ))
    )
      return true;
  }
  return false;
}
async function unknownEffects(harness: Harness, id: ConversationId) {
  const chat = await harness.conversation(id, BACKGROUND_CONTEXT);
  const view = await chat!.context(BACKGROUND_CONTEXT);
  const doc = await harness.snapshot(ExecutionDoc, id, BACKGROUND_CONTEXT);
  const marker = view.entries.findLast((entry) =>
    (entry.model ?? []).some((message) => hasUnknownEffect([message])),
  );
  if (marker) {
    return harness.commit(async (tx) => {
      const state = await tx.doc(ExecutionDoc, id);
      if (Number(marker.id) > (state.acknowledgedThrough ?? 0)) {
        state.unknownThrough = Math.max(
          state.unknownThrough ?? 0,
          Number(marker.id),
        );
        state.unknown = true;
      }
      return state.unknown ?? false;
    }, BACKGROUND_CONTEXT);
  }
  return doc?.unknown ?? false;
}
export function executionDiagnostics(
  getHarness: () => Harness,
  now: () => number,
) {
  return defineExtension({
    name: "moose.execution",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (_request, api, context) => {
          const live = await api.snapshot(LiveDoc, api.conversationId, context);
          await recordExecution(getHarness(), api.conversationId, {
            kind: "request",
            taskId: String(api.taskId),
            ...(live?.run?.inputs[0]
              ? { runId: String(live.run.inputs[0]) }
              : {}),
            phase: "generation",
            at: now(),
            attempt: live?.generation?.attempt ?? 1,
            reason: "request_started",
          });
        },
        afterTools: async (_assistant, _results, api) => {
          await unknownEffects(getHarness(), api.conversationId);
        },
        afterResponse: async (message, api, context) => {
          if (message.errorMessage)
            message.errorMessage =
              message.stopReason === "error"
                ? modelError(message.errorMessage)
                : safeError(message.errorMessage);
          // Provider diagnostics may embed raw bodies/headers. Keep only bounded error names/messages.
          if (message.diagnostics)
            message.diagnostics = message.diagnostics.map((d) => ({
              type: d.type,
              timestamp: d.timestamp,
              ...(d.error
                ? { error: { message: safeError(d.error.message) } }
                : {}),
            }));
          const live = await api.snapshot(LiveDoc, api.conversationId, context);
          const at = now();
          const attempt = live?.generation?.attempt ?? 1;
          (message.diagnostics ??= []).push({
            type: "moose.attempt",
            timestamp: at,
            details: {
              taskId: String(api.taskId),
              phase: "generation",
              attempt,
              ...(live?.run?.inputs[0]
                ? { runId: String(live.run.inputs[0]) }
                : {}),
            },
          });
          await recordExecution(getHarness(), api.conversationId, {
            kind: "response",
            taskId: String(api.taskId),
            ...(live?.run?.inputs[0]
              ? { runId: String(live.run.inputs[0]) }
              : {}),
            phase: "generation",
            at,
            responseAt: message.timestamp,
            attempt,
            reason: message.stopReason,
            ...(message.errorMessage ? { message: message.errorMessage } : {}),
          });
        },
      }),
      hook(ToolTask, {
        beforeTool: async (call, api) => {
          // A fresh call ID must not bypass the SDK's unsafe-intent replay rule.
          if (["read", "workspace_list"].includes(call.name)) return;
          if (await unknownEffects(getHarness(), api.conversationId))
            return {
              block:
                "An earlier operation has an unknown outcome. Inspect its effects and ask the user before another mutation; do not automatically repeat it.",
            };
        },
      }),
    ],
  });
}
export type AttemptFailure = {
  reason: string;
  message: string;
  at: number;
  phase: string;
  retries: number | null;
  recovered: boolean;
};
export type ExecutionStatus = {
  state:
    | "idle"
    | "running"
    | "retrying"
    | "waiting_network"
    | "waiting_authorization"
    | "completed"
    | "failed"
    | "cancelled";
  retries: number;
  unknownEffects?: boolean;
  retryAt?: number;
  reason?: string;
};
type View = Pick<ConversationView, "entries"> &
  Partial<Pick<ConversationView, "docs">>;
export function executionEvents(view: View): ExecutionEvent[] {
  const events = [
    ...((
      view.docs?.["moose.execution"] as unknown as { events?: ExecutionEvent[] }
    )?.events ?? []),
  ];
  for (const entry of view.entries)
    for (const message of entry.model ?? []) {
      if (message.role !== "assistant") continue;
      const meta = message.diagnostics?.find((d) => d.type === "moose.attempt");
      const data = meta?.details;
      if (
        !meta ||
        typeof data?.taskId !== "string" ||
        typeof data.attempt !== "number"
      )
        continue;
      if (
        events.some(
          (e) =>
            e.kind === "response" &&
            e.taskId === data.taskId &&
            e.responseAt === message.timestamp,
        )
      )
        continue;
      events.push({
        kind: "response",
        taskId: data.taskId,
        ...(typeof data.runId === "string" ? { runId: data.runId } : {}),
        at: meta.timestamp,
        responseAt: message.timestamp,
        attempt: data.attempt,
        phase: "generation",
        reason: message.stopReason,
        ...(message.errorMessage
          ? { message: safeError(message.errorMessage) }
          : {}),
      });
    }
  return events.sort((a, b) => a.at - b.at);
}

function currentStatus(view: View, approval = false): ExecutionStatus {
  const live = view.docs?.["pi.live"] as unknown as LiveState | undefined;
  const messages = view.entries.flatMap((e) => e.model ?? []);
  const lastUser = messages.findLast((m) => m.role === "user");
  const allEvents = executionEvents(view);
  const runId = live?.run?.inputs[0]
    ? String(live.run.inputs[0])
    : allEvents.at(-1)?.runId;
  const events = allEvents.filter((e) =>
    runId ? e.runId === runId : e.at >= (lastUser?.timestamp ?? 0),
  );
  const attempts = new Map<string, number>();
  for (const event of events)
    attempts.set(
      event.taskId,
      Math.max(attempts.get(event.taskId) ?? 1, event.attempt),
    );
  if (live?.run && live.generation)
    attempts.set(
      String(live.run.taskId),
      Math.max(
        attempts.get(String(live.run.taskId)) ?? 1,
        live.generation.attempt,
      ),
    );
  const retries = [...attempts.values()].reduce(
    (sum, attempt) => sum + Math.max(0, attempt - 1),
    0,
  );
  if (approval) return { state: "waiting_authorization", retries };
  if (live?.run) {
    if (live.generation?.retry)
      return {
        state: /network|connection|fetch|socket|timed? ?out|terminated/i.test(
          live.generation.retry.error,
        )
          ? "waiting_network"
          : "retrying",
        retries,
        retryAt: live.generation.retry.at,
      };
    return { state: "running", retries };
  }
  const outcome = view.docs?.["moose.outcome"] as unknown as
    { reason: string } | undefined;
  if (outcome) return { state: "failed", retries, reason: outcome.reason };
  const last = messages.at(-1);
  const cancel = events.findLast((e) => e.kind === "cancel");
  if (
    cancel &&
    !(
      last?.role === "assistant" &&
      ["stop", "length"].includes(last.stopReason) &&
      last.timestamp > cancel.at
    )
  )
    return { state: "cancelled", retries, reason: cancel.reason };
  if (last?.role === "assistant") {
    if (["stop", "length"].includes(last.stopReason))
      return { state: "completed", retries };
    if (last.stopReason === "error")
      return {
        state: /401|403|unauthori[sz]ed|sign.in|API key|session.*expired/i.test(
          last.errorMessage ?? "",
        )
          ? "waiting_authorization"
          : "failed",
        retries,
        reason: safeError(last.errorMessage ?? "Model response failed"),
      };
    if (last.stopReason === "aborted")
      return {
        state: "cancelled",
        retries,
        reason: cancel?.reason ?? "interrupted_unknown",
      };
  }
  // A tool task can fault without a final assistant entry. Do not call it completed.
  return {
    state: lastUser ? "failed" : "idle",
    retries,
    ...(lastUser ? { reason: "No completed answer was committed" } : {}),
  };
}
export function executionStatus(view: View, approval = false): ExecutionStatus {
  const status = currentStatus(view, approval);
  const unknown = !!(
    view.docs?.["moose.execution"] as unknown as { unknown?: boolean }
  )?.unknown;
  return unknown
    ? {
        ...status,
        state:
          status.state === "cancelled" ? "cancelled" : "waiting_authorization",
        reason:
          status.state === "cancelled"
            ? `${status.reason ?? "stopped"}; review the interrupted operation`
            : "Review the interrupted operation before allowing more changes",
        unknownEffects: true,
      }
    : status;
}
export function statusLabel(status: ExecutionStatus): string {
  const labels = {
    idle: "",
    running: "Running",
    retrying: "Retrying",
    waiting_network: "Waiting for network · retry scheduled",
    waiting_authorization: "Waiting for authorization",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Stopped",
  };
  return `${labels[status.state]}${status.retries ? ` · ${status.retries} ${status.retries === 1 ? "retry" : "retries"}` : ""}${status.reason ? ` · ${status.reason.replaceAll("_", " ").slice(0, 160)}` : ""}`;
}

export function executionDetails(view: View): string {
  const status = executionStatus(view);
  const events = executionEvents(view)
    .filter(
      (event) =>
        event.kind !== "response" ||
        !["stop", "toolUse", "length"].includes(event.reason),
    )
    .slice(-8);
  const outcome = view.docs?.["moose.outcome"] as unknown as
    { at: number; phase: string; reason: string } | undefined;
  return [
    statusLabel(status),
    ...(outcome
      ? [
          `${new Date(outcome.at).toLocaleString()} · ${outcome.phase} · ${outcome.reason}`,
        ]
      : []),
    ...events.map((event) =>
      [
        new Date(event.at).toLocaleString(),
        event.phase,
        event.reason.replaceAll("_", " "),
        `${Math.max(0, event.attempt - 1)} retries`,
        event.message ?? "",
      ]
        .filter(Boolean)
        .join(" · "),
    ),
  ].join("\n\n");
}
