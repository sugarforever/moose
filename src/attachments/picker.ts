import {
  base64Size,
  validateAttachments,
  MAX_ATTACHMENT_SIZE,
  type Attachment,
} from "../runtime/attachments";
export type AttachmentSource = "files" | "photos" | "camera";
export interface PickedAsset {
  uri: string;
  name: string;
  mimeType: string;
  size?: number;
  width?: number;
  height?: number;
}
export interface PickerAdapter {
  pick(source: AttachmentSource, remaining: number): Promise<PickedAsset[]>;
  read(asset: PickedAsset): Promise<string>;
  normalizeImage(
    asset: PickedAsset,
  ): Promise<{ data: string; mimeType: string }>;
  id(): string;
  release?(assets: readonly PickedAsset[]): Promise<void> | void;
}
export async function collectAttachments(
  source: AttachmentSource,
  remaining: number,
  adapter: PickerAdapter,
): Promise<Attachment[]> {
  if (remaining < 1) throw new Error("Add up to 4 attachments per message");
  const assets = await adapter.pick(source, remaining);
  try {
    if (assets.length > remaining)
      throw new Error("Add up to 4 attachments per message");
    const attachments: Attachment[] = [];
    for (const asset of assets) {
      if (asset.size !== undefined && asset.size > MAX_ATTACHMENT_SIZE)
        throw new Error("Each attachment must be no larger than 8 MiB");
      const image = asset.mimeType.startsWith("image/") || source !== "files";
      const result = image
        ? await adapter.normalizeImage(asset)
        : { data: await adapter.read(asset), mimeType: asset.mimeType };
      let name =
        asset.name
          .split(/[/\\]/)
          .at(-1)
          ?.replace(/[\x00-\x1f]/g, "")
          .slice(0, 170) || "Attachment";
      if (name === "." || name === "..") name = "Attachment";
      if (image) name = name.replace(/\.[^.]+$/, "") + ".jpg";
      attachments.push({
        id: adapter.id(),
        name,
        mimeType: result.mimeType,
        data: result.data,
        size: base64Size(result.data),
      });
    }
    validateAttachments(attachments);
    return attachments;
  } finally {
    await adapter.release?.(assets);
  }
}
