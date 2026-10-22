import { expect, it } from "vitest";
import {
  groupActivities,
  activitySummary,
  type ActivityMessage,
} from "../src/ui/chat-activity";
const user = (entryId: number): ActivityMessage => ({
  entryId,
  role: "user",
  text: "Question",
});
const tool = (id: string, entryId: number, error = false): ActivityMessage => ({
  entryId,
  role: "assistant",
  text: id,
  activity: {
    id,
    label: `${id} · ${error ? "Failed" : "Completed"}`,
    output: id,
    error,
  },
});
it("collapses a turn's tools while preserving interleaved prose and separate turns", () => {
  const prose: ActivityMessage = {
    entryId: 3,
    role: "assistant",
    text: "Progress",
  };
  const input = [
    user(1),
    tool("a", 2),
    prose,
    tool("b", 4),
    user(5),
    tool("c", 6),
  ];
  const before = JSON.stringify(input);
  const result = groupActivities(input, []);
  expect(result.map((x) => x.activities?.map((a) => a.id) ?? x.text)).toEqual([
    "Question",
    ["a", "b"],
    "Progress",
    "Question",
    ["c"],
  ]);
  expect(JSON.stringify(input)).toBe(before);
});
it("reuses the first activity identity as live calls complete and supports live-only turns", () => {
  const live = [{ id: "b", label: "bash · Running", active: true }];
  const running = groupActivities([user(1), tool("a", 2)], live);
  expect(running[1].activities?.map((x) => x.id)).toEqual(["a", "b"]);
  expect(
    groupActivities([user(1), tool("a", 2), tool("b", 3)], [])[1]
      .activities?.[0].id,
  ).toBe(running[1].activities?.[0].id);
  expect(groupActivities([user(1)], live)[1].activities).toEqual(live);
  expect(groupActivities([], [])).toEqual([]);
});
it("shows current running work instead of queued work and exposes failures on completion", () => {
  expect(
    activitySummary([
      { id: "a", label: "read · Running", active: true },
      { id: "b", label: "bash · Pending", active: true },
    ]),
  ).toEqual({ label: "read · Running", active: true, error: false });
  expect(
    activitySummary([
      { id: "a", label: "read · Completed" },
      { id: "b", label: "bash · Failed", error: true },
    ]),
  ).toEqual({
    label: "Worked · 2 activities · Failed",
    active: false,
    error: true,
  });
  expect(
    activitySummary([{ id: "a", label: "Thinking", active: true }]).label,
  ).toBe("Thinking");
});
it("never attaches new live work to a previous user turn", () => {
  const result = groupActivities(
    [user(1), tool("a", 2), user(3)],
    [{ id: "new", label: "Thinking", active: true }],
  );
  expect(result[1].activities?.map((x) => x.id)).toEqual(["a"]);
  expect(result[3].activities?.map((x) => x.id)).toEqual(["new"]);
});

it("keeps the disclosure key stable from live-only work to committed results", () => {
  const live = [{ id: "tool:call", label: "read · Running", active: true }];
  const running = groupActivities([user(10)], live);
  const completed = groupActivities([user(10), tool("result:call", 11)], []);
  expect(running[1].groupId).toBe("activity:10");
  expect(completed[1].groupId).toBe(running[1].groupId);
  expect(activitySummary(completed[1].activities!).active).toBe(false);
});
