/** Controlled OpenAI SSE, through the same transport and generated engine as the app. */
export function sseResponse(body: string): Response {
  const response = new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
  // React Native's global Response may omit body; provide a controlled stream for this fixture.
  if (!response.body)
    Object.defineProperty(response, "body", {
      value: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      }),
    });
  return response;
}
export function responseEvents(
  step: number,
  calls: { name: string; arguments: Record<string, unknown> }[],
  finalText = "Verified",
) {
  const call = calls[step];
  const item = call
    ? {
        type: "function_call",
        id: `fc_${step}`,
        call_id: `call_${step}`,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
        status: "completed",
      }
    : {
        type: "message",
        id: `msg_${step}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: finalText, annotations: [] }],
      };
  const response = {
    id: `resp_${step}`,
    object: "response",
    status: "completed",
    output: [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  const events: Record<string, unknown>[] = [
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: call
        ? { ...item, arguments: "", status: "in_progress" }
        : { ...item, content: [] },
    },
  ];
  if (call)
    events.push(
      {
        type: "response.function_call_arguments.delta",
        item_id: item.id,
        output_index: 0,
        delta: JSON.stringify(call.arguments),
      },
      {
        type: "response.function_call_arguments.done",
        item_id: item.id,
        output_index: 0,
        arguments: JSON.stringify(call.arguments),
      },
    );
  else
    events.push(
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
        delta: finalText,
      },
      {
        type: "response.output_text.done",
        output_index: 0,
        content_index: 0,
        text: finalText,
      },
    );
  events.push(
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  );
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}
