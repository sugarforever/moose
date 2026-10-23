import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { File, Paths } from "expo-file-system";
import { randomUUID } from "expo-crypto";
import {
  collectAttachments,
  type AttachmentSource,
  type PickedAsset,
  type PickerAdapter,
} from "../attachments/picker";
import { MAX_ATTACHMENT_SIZE } from "../runtime/attachments";

const mimeType = (name: string, type?: string | null) => {
  if (type && type !== "application/octet-stream") return type;
  const ext = name.split(".").at(-1)?.toLowerCase();
  return (
    (
      {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        heic: "image/heic",
        heif: "image/heif",
        gif: "image/gif",
        webp: "image/webp",
        txt: "text/plain",
        md: "text/markdown",
        pdf: "application/pdf",
      } as Record<string, string>
    )[ext ?? ""] ?? "application/octet-stream"
  );
};
function localFile(asset: PickedAsset) {
  const file = new File(asset.uri);
  if (!file.exists)
    throw new Error("This attachment is no longer available. Select it again");
  if (file.size > MAX_ATTACHMENT_SIZE)
    throw new Error("Each attachment must be no larger than 8 MiB");
  return file;
}
const adapter: PickerAdapter = {
  id: randomUUID,
  release(assets) {
    for (const asset of assets) {
      try {
        const file = new File(asset.uri);
        // Only picker-owned cache copies; never delete the source in a document provider or photo library.
        if (
          file.uri.startsWith(Paths.cache.uri.replace(/\/$/, "") + "/") &&
          file.exists
        )
          file.delete();
      } catch {
        /* Cache eviction must not discard a captured attachment. */
      }
    }
  },
  async pick(source, remaining) {
    if (source === "files") {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
        type: "*/*",
      });
      return result.canceled
        ? []
        : result.assets.map((a) => ({
            ...a,
            mimeType: mimeType(a.name, a.mimeType),
          }));
    }
    if (source === "camera") {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted)
        throw new Error(
          "Camera access is disabled. Allow Moose to use the camera in system settings",
        );
    }
    // The system photo picker grants access only to selected photos; no broad library permission is needed.
    const result =
      source === "camera"
        ? await ImagePicker.launchCameraAsync({
            mediaTypes: ["images"],
            quality: 1,
          })
        : await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ["images"],
            allowsMultipleSelection: true,
            selectionLimit: remaining,
            quality: 1,
          });
    return result.canceled
      ? []
      : result.assets.map((a) => ({
          uri: a.uri,
          name: a.fileName ?? "Photo.jpg",
          mimeType: mimeType(a.fileName ?? "Photo.jpg", a.mimeType),
          size: a.fileSize,
          width: a.width,
          height: a.height,
        }));
  },
  async read(asset) {
    return localFile(asset).base64();
  },
  async normalizeImage(asset) {
    localFile(asset);
    const context = ImageManipulator.manipulate(asset.uri);
    let original: Awaited<ReturnType<typeof context.renderAsync>> | undefined;
    let resized: typeof original;
    try {
      original = await context.renderAsync();
      if (Math.max(original.width, original.height) > 2048) {
        context.resize(
          original.width >= original.height
            ? { width: 2048 }
            : { height: 2048 },
        );
        resized = await context.renderAsync();
      }
      const result = await (resized ?? original).saveAsync({
        format: SaveFormat.JPEG,
        compress: 0.85,
        base64: true,
      });
      try {
        if (!result.base64)
          throw new Error("Cannot read this image. Select it again");
        return { data: result.base64, mimeType: "image/jpeg" };
      } finally {
        const temporary = new File(result.uri);
        if (temporary.exists) temporary.delete();
      }
    } finally {
      resized?.release();
      original?.release();
      context.release();
    }
  },
};
export function pickAttachments(source: AttachmentSource, remaining: number) {
  return collectAttachments(source, remaining, adapter);
}
