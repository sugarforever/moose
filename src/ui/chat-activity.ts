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

export type ActivityGroupMessage = ActivityMessage & {
  groupId?: string;
  activities?: Activity[];
};

// A turn owns one disclosure even when assistant prose separates its tool calls.
export function groupActivities(
  messages: ActivityMessage[],
  live: Activity[],
): ActivityGroupMessage[] {
  const result: ActivityGroupMessage[] = [];
  let turn = 0;
  let group: ActivityGroupMessage | undefined;
  function append(activity: Activity, entryId: number) {
    if (!group) {
      group = {
        entryId,
        role: "assistant",
        text: "",
        groupId: `activity:${turn}`,
        activities: [],
      };
      result.push(group);
    }
    group.activities!.push(activity);
  }
  for (const message of messages) {
    if (message.role === "user") {
      turn = message.entryId;
      group = undefined;
    }
    if (message.activity) append(message.activity, message.entryId);
    else result.push(message);
  }
  for (const activity of live) append(activity, turn);
  return result;
}

export function activitySummary(activities: Activity[]) {
  const active = activities.filter((activity) => activity.active);
  const current =
    active
      .filter((activity) => !activity.label.endsWith(" · Pending"))
      .at(-1) ?? active.at(-1);
  const error = activities.some((activity) => activity.error);
  return {
    label:
      current?.label ??
      `Worked · ${activities.length} ${activities.length === 1 ? "activity" : "activities"}${error ? " · Failed" : ""}`,
    active: !!current,
    error: !current && error,
  };
}
