import { expect, it } from "vitest";
import {
  collectAttachments,
  type PickerAdapter,
} from "../src/attachments/picker";
const asset = {
  uri: "cache://temporary",
  name: "note.txt",
  mimeType: "text/plain",
  size: 2,
};
function adapter(changes: Partial<PickerAdapter> = {}): PickerAdapter {
  return {
    pick: async () => [asset],
    read: async () => "aGk=",
    normalizeImage: async (a) => ({
      ...a,
      mimeType: "image/jpeg",
      data: "aGk=",
    }),
    id: () => "unique-1",
    ...changes,
  };
}
it("makes selected files independent of temporary URIs", async () => {
  expect(await collectAttachments("files", 4, adapter())).toEqual([
    {
      id: "unique-1",
      name: "note.txt",
      mimeType: "text/plain",
      size: 2,
      data: "aGk=",
    },
  ]);
});
it("treats cancellation as empty and propagates permission errors", async () => {
  expect(
    await collectAttachments("camera", 4, adapter({ pick: async () => [] })),
  ).toEqual([]);
  await expect(
    collectAttachments(
      "camera",
      4,
      adapter({
        pick: async () => {
          throw new Error("Camera access is disabled");
        },
      }),
    ),
  ).rejects.toThrow("Camera access");
});
it("checks number and size before reading bytes", async () => {
  const unread = async () => {
    throw new Error("must not read");
  };
  await expect(
    collectAttachments("files", 0, adapter({ read: unread })),
  ).rejects.toThrow("4");
  await expect(
    collectAttachments(
      "files",
      4,
      adapter({
        pick: async () => [{ ...asset, size: 8388609 }],
        read: unread,
      }),
    ),
  ).rejects.toThrow("8 MiB");
});
it("normalizes HEIC into JPEG and retains a safe unique filename", async () => {
  expect(
    await collectAttachments(
      "photos",
      4,
      adapter({
        pick: async () => [
          { ...asset, name: "../相片.heic", mimeType: "image/heic" },
        ],
      }),
    ),
  ).toEqual([
    {
      id: "unique-1",
      name: "相片.jpg",
      mimeType: "image/jpeg",
      size: 2,
      data: "aGk=",
    },
  ]);
});

it("releases picker resources after capture and after validation failure", async () => {
  const { mkdtemp, writeFile, access, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "moose-picker-"));
  try {
    for (const size of [2, 8388609]) {
      const path = join(root, "picked.txt");
      await writeFile(path, "hi");
      const operation = collectAttachments(
        "files",
        4,
        adapter({
          pick: async () => [{ ...asset, uri: path, size }],
          release: async (assets) => {
            for (const a of assets) await rm(a.uri);
          },
        }),
      );
      if (size === 2) await operation;
      else await expect(operation).rejects.toThrow("8 MiB");
      await expect(access(path)).rejects.toThrow();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
