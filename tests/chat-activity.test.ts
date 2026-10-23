import { expect, it } from "vitest";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { chatActivity, toolMessages } from "../src/ui/chat-activity";

const run = { taskId: 1, inputs: [1] } as LiveState["run"];
function view(model: unknown[]): Pick<ConversationView, "entries"> {
  return {
    entries: model.map((message, i) => ({ id: i + 1, model: [message] })),
  } as unknown as Pick<ConversationView, "entries">;
}
it("keeps successful and failed tool results in transcript order, without exposing arguments", () => {
  const result = toolMessages(
    view([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "a",
            name: "read",
            arguments: { secret: "hidden" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "a",
        toolName: "read",
        content: [{ type: "text", text: "file contents" }],
        isError: false,
      },
      {
        role: "toolResult",
        toolCallId: "b",
        toolName: "write",
        content: [{ type: "text", text: "permission denied" }],
        isError: true,
      },
    ]),
  );
  expect(
    result.map((m) => [
      m.entryId,
      m.activity.label,
      m.error,
      m.activity.output,
    ]),
  ).toEqual([
    [2, "read · Completed", false, "file contents"],
    [3, "write · Failed", true, "permission denied"],
  ]);
  expect(JSON.stringify(result)).not.toContain("hidden");
});
it("shows queued and nested running tools while suppressing completed transcript duplicates", () => {
  const live = {
    run,
    tools: [
      { callId: "a", name: "read", status: "done", entry: 2 },
      { callId: "b", name: "codemode", status: "running", taskId: 3 },
      { callId: "c", name: "write", status: "pending" },
    ],
    nestedTools: [
      {
        callId: "b/1",
        parentCallId: "b",
        parentTaskId: 3,
        taskId: 4,
        arguments: {},
        name: "read",
        status: "running",
        output: "loading",
      },
    ],
  } as LiveState;
  expect(chatActivity(live).map((r) => [r.label, r.output])).toEqual([
    ["codemode · Running", undefined],
    ["write · Pending", undefined],
    ["read · Running", "loading"],
  ]);
});
it("bounds output and marks missing tool results as interrupted rather than successful", () => {
  const rows = chatActivity({
    run,
    tools: [
      { callId: "a", name: "read", status: "done" },
      {
        callId: "b",
        name: "write",
        status: "running",
        output: "x".repeat(10000),
      },
    ],
  });
  expect(rows[0].label).toContain("Interrupted");
  expect(rows[1].output!.length).toBeLessThanOrEqual(4001);
  expect(rows[1].output).toContain("…");
});
it("clears run presentation after stop and uses a minimal waiting fallback", () => {
  expect(chatActivity(undefined)).toEqual([]);
  expect(
    chatActivity({ tools: [{ callId: "a", name: "read", status: "running" }] }),
  ).toEqual([]);
  expect(chatActivity({ run }).map((r) => r.label)).toEqual([
    "Waiting for response",
  ]);
});
it("shows retry, deferred and compaction states without displaying private model thinking", () => {
  expect(
    chatActivity({
      run,
      generation: { attempt: 2, retry: { at: 123, error: "private" } },
    }).map((r) => r.label),
  ).toEqual(["Retrying · Attempt 2"]);
  expect(
    chatActivity({
      run,
      generation: { attempt: 1, deferred: { pollAt: 123 } },
    }).map((r) => r.label),
  ).toEqual(["Waiting for model"]);
  expect(
    chatActivity({
      run,
      compactions: [
        { taskId: 2, reason: "manual", blocking: true, attempt: 1 },
      ],
    } as LiveState).map((r) => r.label),
  ).toEqual(["Compacting context"]);
  const rows = chatActivity({
    run,
    generation: {
      attempt: 1,
      message: {
        content: [{ type: "thinking", thinking: "private reasoning" }],
      },
    },
  } as LiveState);
  expect(rows.map((r) => r.label)).toEqual(["Thinking"]);
  expect(JSON.stringify(rows)).not.toContain("private reasoning");
});
it("keeps current generation visible alongside a retained compaction failure", () => {
  const rows = chatActivity({
    run,
    compactionFailure: { taskId: 2, reason: "manual", error: "old" },
    generation: {
      attempt: 1,
      message: { content: [{ type: "thinking", thinking: "hidden" }] },
    },
  } as LiveState);
  expect(rows.map((row) => row.label)).toEqual([
    "Context compaction failed",
    "Thinking",
  ]);
  expect(rows.some((row) => row.active)).toBe(true);
});
