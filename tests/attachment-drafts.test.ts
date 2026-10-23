import { expect, it } from "vitest";
import { AttachmentDrafts } from "../src/attachments/drafts";
const file = {
  id: "a",
  name: "a.txt",
  mimeType: "text/plain",
  data: "aGk=",
  size: 2,
};
it("does not attach a late picker result after switching away and back", async () => {
  const drafts = new AttachmentDrafts();
  drafts.activate(1);
  let finish!: (items: (typeof file)[]) => void;
  const picking = drafts.select(
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  drafts.activate(2);
  drafts.activate(1);
  finish([file]);
  expect(await picking).toBe(false);
  expect(drafts.items).toEqual([]);
});
it("retains drafts per conversation and removes only the submitted snapshot", async () => {
  const drafts = new AttachmentDrafts();
  drafts.activate(1);
  await drafts.select(async () => [file]);
  drafts.activate(2);
  expect(drafts.items).toEqual([]);
  drafts.activate(1);
  expect(drafts.items).toEqual([file]);
  drafts.remove("a");
  expect(drafts.items).toEqual([]);
});
