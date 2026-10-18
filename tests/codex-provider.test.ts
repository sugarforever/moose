import { expect, it } from "vitest";
import { createMobileModels } from "../src/runtime/providers";
import { zstdDecompressSync } from "node:zlib";

it("sends subscription traffic only to the Codex backend with account routing and native SSE", async () => {
  const bearer = `h.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-subscription" } }))}.s`;
  const requests: Request[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const message = {
      type: "message",
      id: "msg_codex",
      role: "assistant",
      status: "completed",
      content: [
        { type: "output_text", text: "Subscription reply", annotations: [] },
      ],
    };
    const response = {
      id: "resp_codex",
      object: "response",
      status: "completed",
      output: [message],
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    };
    const events = [
      {
        type: "response.created",
        response: { ...response, output: [], status: "in_progress" },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...message, content: [] },
      },
      {
        type: "response.content_part.added",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: "Subscription reply",
      },
      {
        type: "response.output_text.done",
        output_index: 0,
        content_index: 0,
        text: "Subscription reply",
      },
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.completed", response },
    ];
    return new Response(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const models = createMobileModels(
    async () => {
      throw new Error("API key fallback must not run");
    },
    fetcher,
    async () => bearer,
  );
  const model = models.getModel("openai-codex", "gpt-5.6-luna");
  expect(model).toBeDefined();
  const result = await models
    .streamSimple(model!, {
      systemPrompt: "Be helpful",
      messages: [{ role: "user", content: "Hello", timestamp: 0 }],
    })
    .result();
  expect(result.stopReason).toBe("stop");
  expect(result.content).toContainEqual(
    expect.objectContaining({ type: "text", text: "Subscription reply" }),
  );
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe(
    "https://chatgpt.com/backend-api/codex/responses",
  );
  expect(requests[0].headers.get("authorization")).toBe(`Bearer ${bearer}`);
  expect(requests[0].headers.get("chatgpt-account-id")).toBe(
    "account-subscription",
  );
  expect(requests[0].headers.get("originator")).toBe("moose");
  expect(requests[0].headers.get("accept")).toBe("text/event-stream");
  const raw = Buffer.from(await requests[0].arrayBuffer());
  const body = JSON.parse(
    (requests[0].headers.get("content-encoding") === "zstd"
      ? zstdDecompressSync(raw)
      : raw
    ).toString("utf8"),
  );
  expect(body.store).toBe(false);
  expect(body.stream).toBe(true);
});

it("requires subscription authorization and never falls back to an API key", async () => {
  const models = createMobileModels(
    async () => "ordinary-api-key",
    async () => {
      throw new Error("No request should be made");
    },
    async () => null,
  );
  const model = models.getModel("openai-codex", "gpt-5.6-luna");
  expect(model).toBeDefined();
  const result = await models
    .streamSimple(model!, {
      messages: [{ role: "user", content: "Hello", timestamp: 0 }],
    })
    .result();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("ChatGPT");
});
