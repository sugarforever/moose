import { zstdDecompressSync } from "node:zlib";
import { expect, it } from "vitest";
import { createMobileModels } from "../src/runtime/providers";
import { attachmentContent } from "../src/runtime/attachments";
const image = {
  id: "photo",
  name: "photo.png",
  mimeType: "image/png",
  data: "aGk=",
  size: 2,
};
for (const [provider, modelId] of [
  ["openai", "gpt-4.1-mini"],
  ["anthropic", "claude-sonnet-4-5"],
  ["openai-codex", "gpt-5.6-luna"],
]) {
  it(`sends genuine image data through ${provider} without mixing credentials`, async () => {
    let request: Request | undefined;
    const models = createMobileModels(
      async (p) => `key-${p}`,
      async (url, init) => {
        request = new Request(url, init);
        return new Response("", { status: 400 });
      },
      async () =>
        `test.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }))}.sig`,
    );
    const model = models.getModel(provider, modelId);
    expect(model).toBeDefined();
    await models
      .streamSimple(model!, {
        messages: [
          {
            role: "user",
            content: attachmentContent("look", [image]),
            timestamp: 0,
          },
        ],
      })
      .result();
    expect(request).toBeDefined();
    const raw = Buffer.from(await request!.arrayBuffer());
    const body = JSON.parse(
      (request!.headers.get("content-encoding") === "zstd"
        ? zstdDecompressSync(raw)
        : raw
      ).toString("utf8"),
    );
    if (provider === "anthropic") {
      expect(body.messages[0].content).toContainEqual(
        expect.objectContaining({
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "aGk=" },
        }),
      );
      expect(request!.headers.get("x-api-key")).toBe("key-anthropic");
    } else {
      expect(
        body.input.flatMap((m: { content?: unknown[] }) => m.content ?? []),
      ).toContainEqual(
        expect.objectContaining({
          type: "input_image",
          image_url: "data:image/png;base64,aGk=",
        }),
      );
      if (provider === "openai-codex") {
        expect(request!.url).toContain("chatgpt.com/backend-api");
        expect(request!.headers.get("chatgpt-account-id")).toBe("test-account");
        expect(request!.headers.get("authorization")).not.toBe(
          "Bearer key-openai",
        );
      } else
        expect(request!.headers.get("authorization")).toBe("Bearer key-openai");
    }
  });
}
