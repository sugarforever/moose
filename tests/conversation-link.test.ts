import { expect, it } from "vitest";
import { conversationLink } from "../src/ui/conversation-link";
it("accepts exact conversation IDs and rejects malformed or foreign links", () => {
  expect(conversationLink("moose://conversation/42")).toBe(42);
  for (const value of [
    null,
    "https://conversation/42",
    "moose://conversation/0",
    "moose://conversation/-1",
    "moose://conversation/1?submit=hi",
    "moose://conversation/9007199254740992",
    "moose://conversation/1/submit",
  ])
    expect(conversationLink(value)).toBeUndefined();
});
