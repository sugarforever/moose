import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import type { ChatMessage } from "../runtime/engine";

export type Activity = {
  id: string;
  label: string;
  output?: string;
  active?: boolean;
  error?: boolean;
};
export type ActivityMessage = ChatMessage & { activity?: Activity };

// Presentation stays bounded even for tools returning large files or logs.
function bounded(text?: string): string | undefined {
  if (!text) return undefined;
  return text.length > 4000 ? `…${text.slice(-4000)}` : text;
}

export function toolMessages(
  view: Pick<ConversationView, "entries">,
): (ChatMessage & { activity: Activity })[] {
  return view.entries.flatMap((entry) =>
    (entry.model ?? []).flatMap((message) => {
      if (message.role !== "toolResult") return [];
      const label = `${message.toolName} · ${message.isError ? "Failed" : "Completed"}`;
      return [
        {
          entryId: Number(entry.id),
          role: "assistant" as const,
          text: label,
          error: message.isError,
          activity: {
            id: `result:${entry.id}:${message.toolCallId}`,
            label,
            error: message.isError,
            output: bounded(
              message.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("\n"),
            ),
          },
        },
      ];
    }),
  );
}

export function chatActivity(live?: LiveState): Activity[] {
  const rows: Activity[] = [];
  for (const compaction of live?.compactions ?? []) {
    rows.push({
      id: `compact:${compaction.taskId}`,
      label: compaction.retry
        ? "Waiting to retry context compaction"
        : "Compacting context",
      active: true,
    });
  }
  if (live?.compactionFailure)
    rows.push({
      id: "compaction-error",
      label: "Context compaction failed",
      error: true,
    });
  if (!live?.run) return rows;
  for (const slot of [...(live.tools ?? []), ...(live.nestedTools ?? [])]) {
    if (slot.status === "done" && "entry" in slot && slot.entry !== undefined)
      continue;
    const nested = "parentCallId" in slot;
    const error =
      slot.status === "done" &&
      (nested ? slot.summary?.isError !== false : true);
    const state =
      slot.status === "pending"
        ? "Pending"
        : slot.status === "running"
          ? "Running"
          : error
            ? nested && slot.summary
              ? "Failed"
              : "Interrupted"
            : "Completed";
    rows.push({
      id: `tool:${slot.callId}`,
      label: `${slot.name} · ${state}`,
      active: slot.status !== "done",
      error,
      output: bounded(
        slot.output ?? (nested ? slot.summary?.error : undefined),
      ),
    });
  }
  const generation = live.generation;
  if (generation?.retry)
    rows.push({
      id: "generation",
      label: `Retrying · Attempt ${generation.attempt}`,
      active: true,
    });
  else if (generation?.deferred)
    rows.push({ id: "generation", label: "Waiting for model", active: true });
  else if (!rows.some((row) => row.active)) {
    const content = generation?.message?.content ?? [];
    if (!content.some((block) => block.type === "text" && block.text)) {
      rows.push({
        id: "generation",
        label: content.some((block) => block.type === "thinking")
          ? "Thinking"
          : "Waiting for response",
        active: true,
      });
    }
  }
  return rows;
}
