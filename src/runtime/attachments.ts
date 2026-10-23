import type { UserMessage } from "@earendil-works/pi-ai";
export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  /** Durable bytes, shared by outbox, transcript and checkpoint branches. */
  data: string;
  size: number;
}
export const MAX_ATTACHMENT_SIZE = 8 * 1024 * 1024;
export function attachmentPath(a: Attachment): string {
  return `/workspace/attachments/${a.id}/${a.name}`;
}
export function validateAttachments(items: readonly Attachment[]): void {
  if (items.length > 4) throw new Error("Add up to 4 attachments per message");
  const ids = new Set<string>();
  for (const a of items) {
    if (
      !/^[a-zA-Z0-9-]{1,80}$/.test(a.id) ||
      ids.has(a.id) ||
      !a.name ||
      a.name.length > 180 ||
      /[/\\\x00-\x1f]/.test(a.name) ||
      a.name === "." ||
      a.name === ".."
    )
      throw new Error("Invalid attachment name");
    ids.add(a.id);
    if (
      !Number.isSafeInteger(a.size) ||
      a.size < 0 ||
      a.size > MAX_ATTACHMENT_SIZE ||
      a.data.length > Math.ceil(MAX_ATTACHMENT_SIZE / 3) * 4
    )
      throw new Error("Each attachment must be no larger than 8 MiB");
    if (
      a.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(a.data) ||
      (a.data.endsWith("==")
        ? a.data.length < 4
        : a.data.endsWith("=") && a.data.length < 4) ||
      base64Size(a.data) !== a.size
    )
      throw new Error("Invalid attachment data");
    if (
      !/^[\w.+-]+\/[\w.+-]+$/.test(a.mimeType) ||
      (a.mimeType.startsWith("image/") &&
        !["image/jpeg", "image/png"].includes(a.mimeType))
    )
      throw new Error("Images must be converted to JPEG or PNG");
  }
}
export function base64Size(data: string): number {
  return (
    (data.length / 4) * 3 -
    (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0)
  );
}
export function decodeAttachment(a: Attachment): Uint8Array {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = new Uint8Array(a.size);
  let bits = 0,
    value = 0,
    index = 0;
  for (const ch of a.data) {
    if (ch === "=") break;
    value = (value << 6) | alphabet.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (value >> bits) & 255;
    }
  }
  return bytes;
}
export function attachmentContent(
  text: string,
  items: readonly Attachment[],
): UserMessage["content"] {
  validateAttachments(items);
  if (!items.length) return text.trim();
  const content: Exclude<UserMessage["content"], string> = [];
  if (text.trim()) content.push({ type: "text", text: text.trim() });
  for (const a of items) {
    if (a.mimeType.startsWith("image/"))
      content.push({ type: "image", data: a.data, mimeType: a.mimeType });
    else
      content.push({
        type: "text",
        text: `Attached file: ${JSON.stringify(a.name)}. Path: ${attachmentPath(a)}. Use the read tool to inspect it; clearly state when its format is unsupported.`,
      });
  }
  return content;
}
