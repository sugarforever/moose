import { expect, it } from "vitest";
import { chatMessages } from "../src/runtime/engine";
import {
  executionStatus,
  safeError,
  hasUnknownEffect,
} from "../src/runtime/execution-diagnostics";

function view(messages: any[], live: any = {}, events: any[] = []) {
  return {
    entries: messages.map((m, i) => ({ id: i + 1, model: [m] })),
    docs: { "pi.live": live, "moose.execution": { events } },
  } as any;
}
const user = { role: "user", content: "do work", timestamp: 1 };
const failure = {
  role: "assistant",
  content: [],
  stopReason: "error",
  errorMessage: "network error",
  timestamp: 2,
};
const success = {
  role: "assistant",
  content: [{ type: "text", text: "done" }],
  stopReason: "stop",
  timestamp: 3,
};
it("keeps failure detail and marks recovered attempts only within the same user turn", () => {
  const messages = chatMessages(view([user, failure, success]));
  expect(messages[1].failure).toMatchObject({
    reason: "error",
    message: "network error",
    at: 2,
    recovered: true,
  });
  expect(
    chatMessages(view([user, failure, user, success]))[1].failure?.recovered,
  ).toBe(false);
  expect(executionStatus(view([user, failure, success])).state).toBe(
    "completed",
  );
});
it("projects retry, authorization, terminal failure and cancellation from committed state", () => {
  const live = {
    run: { taskId: 5, inputs: [] },
    generation: { attempt: 2, retry: { at: 50, error: "network error" } },
  };
  expect(executionStatus(view([user, failure], live))).toMatchObject({
    state: "waiting_network",
    retries: 1,
    retryAt: 50,
  });
  expect(executionStatus(view([user, failure], live), true).state).toBe(
    "waiting_authorization",
  );
  expect(
    executionStatus(
      view([user, { ...failure, errorMessage: "401 unauthorized" }]),
    ).state,
  ).toBe("waiting_authorization");
  expect(executionStatus(view([user, failure])).state).toBe("failed");
  expect(
    executionStatus(
      view([user], {}, [
        {
          reason: "budget_expired",
          phase: "generation",
          at: 5,
          taskId: "5",
          attempt: 1,
          kind: "cancel",
        },
      ]),
    ),
  ).toMatchObject({ state: "cancelled", reason: "budget_expired" });
});
it("redacts credentials and URLs from bounded diagnostic messages", () => {
  const secret =
    'Bearer abc.def Authorization: secret sk-proj-abcdef https://host/path?access_token=secret {"refresh_token":"private"}';
  const safe = safeError(secret);
  for (const value of ["abc.def", "secret", "sk-proj-abcdef", "private"])
    expect(safe).not.toContain(value);
  expect(safeError("x".repeat(5000)).length).toBeLessThanOrEqual(2000);
});
it("unknown tool effects block mutations until a new explicit user turn", () => {
  const unknown = {
    role: "toolResult",
    isError: true,
    content: [],
    diagnostics: [{ code: "interrupted", message: "may have partially run" }],
  };
  expect(hasUnknownEffect([user, unknown])).toBe(true);
  expect(hasUnknownEffect([user, unknown, user])).toBe(false);
});

it("keeps restart and later stop causes attached to their own partial attempts, including retry count", () => {
  const partial = {
    ...failure,
    stopReason: "aborted",
    errorMessage: undefined,
    timestamp: 2,
  };
  const later = { ...partial, timestamp: 4 };
  const result = chatMessages(
    view([user, partial, later], {}, [
      {
        kind: "restart",
        taskId: "5",
        phase: "generation",
        at: 3,
        attempt: 3,
        reason: "runtime_restart",
      },
      {
        kind: "cancel",
        taskId: "5",
        phase: "generation",
        at: 5,
        attempt: 3,
        reason: "user_stop",
      },
    ]),
  );
  expect(result[1].failure).toMatchObject({
    reason: "runtime_restart",
    retries: 2,
  });
  expect(result[2].failure).toMatchObject({ reason: "user_stop", retries: 2 });
});

it("retains attempt metadata in the transcript after the bounded event window expires", () => {
  const older = {
    ...failure,
    diagnostics: [
      {
        type: "moose.attempt",
        timestamp: 2,
        details: { taskId: "8", phase: "generation", attempt: 3 },
      },
    ],
  };
  expect(chatMessages(view([user, older, success]))[1].failure).toMatchObject({
    retries: 2,
    at: 2,
  });
});

it("keeps the run's retry count when a compaction summary replaces the original user message", () => {
  const summary = { ...user, timestamp: 100, content: "compacted history" };
  const final = { ...success, timestamp: 110 };
  expect(
    executionStatus(
      view([summary, final], {}, [
        {
          kind: "response",
          taskId: "5",
          runId: "input-1",
          at: 30,
          attempt: 3,
          reason: "toolUse",
        },
        {
          kind: "response",
          taskId: "8",
          runId: "input-1",
          at: 110,
          attempt: 1,
          reason: "stop",
        },
      ]),
    ).retries,
  ).toBe(2);
});

it("checks the current acknowledgement inside the mutation-guard transaction", async () => {
  const state = {
    events: [],
    unknown: false,
    unknownThrough: 0,
    acknowledgedThrough: 99,
  };
  const harness = {
    conversation: async () => ({
      context: async () => ({
        entries: [
          {
            id: 20,
            model: [
              {
                role: "toolResult",
                content: [
                  { type: "text", text: "<harness>outcome unknown</harness>" },
                ],
              },
            ],
          },
        ],
      }),
    }),
    snapshot: async () => ({ ...state, acknowledgedThrough: 0 }),
    commit: async (change: any) => change({ doc: async () => state }),
  };
  const { executionDiagnostics } =
    await import("../src/runtime/execution-diagnostics");
  const extension = executionDiagnostics(() => harness as any, Date.now);
  const handler = extension.hooks!.find((h) => h.task === "pi.tool")!
    .handlers as any;
  expect(
    await handler.beforeTool({ name: "write" }, { conversationId: 1 }),
  ).toBeUndefined();
  expect(state.unknown).toBe(false);
});

it("persists an unknown-effect latch with cancellation when a mutation intent is still running", async () => {
  const doc = {
    events: [],
    unknown: false,
    acknowledgedThrough: 0,
    unknownThrough: 0,
  };
  const harness = {
    commit: async (change: any) =>
      change({
        doc: async (token: any) =>
          token.definition.kind === "pi.live"
            ? { tools: [{ name: "bash", status: "running" }] }
            : doc,
        scanEntries: async () => ({ items: [{ id: 77 }] }),
      }),
  };
  const { recordExecution } =
    await import("../src/runtime/execution-diagnostics");
  await recordExecution(
    harness as any,
    1 as any,
    {
      kind: "cancel",
      taskId: "5",
      phase: "tool",
      at: 10,
      attempt: 1,
      reason: "user_stop",
    },
    true,
  );
  expect(doc).toMatchObject({ unknown: true, unknownThrough: 77 });
});
