import { expect, it } from "vitest";
import {
  attachmentContent,
  validateAttachments,
  attachmentPath,
} from "../src/runtime/attachments";
const file = {
  id: "file-1",
  name: "notes.txt",
  mimeType: "text/plain",
  data: "aGk=",
  size: 2,
};
it("builds file references without placing binary data in model text", () => {
  expect(attachmentPath(file)).toBe("/workspace/attachments/file-1/notes.txt");
  expect(attachmentContent("", [file])).toEqual([
    {
      type: "text",
      text: 'Attached file: "notes.txt". Path: /workspace/attachments/file-1/notes.txt. Use the read tool to inspect it; clearly state when its format is unsupported.',
    },
  ]);
});
it("keeps images as genuine Pi image blocks", () => {
  expect(
    attachmentContent("Look at this image", [
      { ...file, mimeType: "image/png" },
    ]),
  ).toEqual([
    { type: "text", text: "Look at this image" },
    { type: "image", data: "aGk=", mimeType: "image/png" },
  ]);
});
it("rejects traversal, invalid data, incorrect sizes and excess attachments", () => {
  for (const change of [
    { name: "../secret" },
    { id: "../escape" },
    { data: "invalid" },
    { size: 3 },
    { size: 9 * 1024 * 1024 },
    { mimeType: "image/heic" },
  ]) {
    expect(() => validateAttachments([{ ...file, ...change }])).toThrow();
  }
  expect(() => validateAttachments(Array(5).fill(file))).toThrow();
});
