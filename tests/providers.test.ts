import { expect, it } from "vitest";
import { createMobileModels } from "../src/runtime/providers";

it("uses the native fetch and explicit key for a real Pi OpenAI streaming adapter", async () => {
  let request: Request | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    request = new Request(input, init);
    const response = {
      id: "resp_test",
      object: "response",
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg_test",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "Hello from the transport",
              annotations: [],
            },
          ],
        },
      ],
      usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 },
    };
    const events = [
      {
        type: "response.created",
        response: { ...response, status: "in_progress", output: [] },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...response.output[0], content: [] },
      },
      {
        type: "response.content_part.added",
        item_id: "msg_test",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        item_id: "msg_test",
        output_index: 0,
        content_index: 0,
        delta: "Hello from the transport",
      },
      {
        type: "response.output_text.done",
        item_id: "msg_test",
        output_index: 0,
        content_index: 0,
        text: "Hello from the transport",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: response.output[0],
      },
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
    async (provider) => (provider === "openai" ? "test-local-key" : null),
    fetcher,
  );
  const model = models.getModel("openai", "gpt-4.1-mini")!;
  expect(model).toBeDefined();
  const result = await models
    .streamSimple(model, {
      messages: [{ role: "user", content: "Hello", timestamp: 0 }],
    })
    .result();
  expect(result.stopReason).toBe("stop");
  expect(result.content).toContainEqual(
    expect.objectContaining({ type: "text", text: "Hello from the transport" }),
  );
  expect(request!.headers.get("authorization")).toBe("Bearer test-local-key");
  expect(request!.url).toBe("https://api.openai.com/v1/responses");
});
