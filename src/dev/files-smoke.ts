import { MobileEngine, createMobileModels } from "../generated/runtime";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import type { MobileWorkspaceFactory } from "../runtime/files";

/** Controlled OpenAI SSE, through the same transport and generated engine as the app. */
function sseResponse(body: string): Response {
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
function responseEvents(step: number, shell = false) {
  const calls = [
    {
      name: "write",
      arguments: { path: "notes/smoke.txt", content: "Hello Moose" },
    },
    {
      name: "edit",
      arguments: {
        path: "notes/smoke.txt",
        edits: [{ oldText: "Hello", newText: "你好" }],
      },
    },
    ...(shell
      ? [
          {
            name: "bash",
            arguments: {
              command:
                'printf " guest" >> notes/smoke.txt; cat notes/smoke.txt',
            },
          },
        ]
      : []),
    { name: "read", arguments: { path: "notes/smoke.txt" } },
  ];
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
        content: [
          { type: "output_text", text: "Filesystem verified", annotations: [] },
        ],
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
        delta: "Filesystem verified",
      },
      {
        type: "response.output_text.done",
        output_index: 0,
        content_index: 0,
        text: "Filesystem verified",
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
export async function runFileSmoke(
  openDatabase: () => Promise<SqliteDatabase>,
  workspaceFactory: MobileWorkspaceFactory,
  respond: (body: string) => Response = sseResponse,
) {
  const checks: string[] = [];
  const assert = (ok: unknown, name: string) => {
    if (!ok) throw new Error(name);
    checks.push(name);
  };
  const requests: string[] = [];
  let step = 0;
  const models = createMobileModels(
    async () => "fixture-only-not-a-real-key",
    async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== "https://api.openai.com/v1/responses")
        throw new Error("Unexpected fixture transport URL");
      requests.push(await request.text());
      return respond(responseEvents(step++, workspaceFactory.shell));
    },
  );
  const settings = { provider: "openai", modelId: "gpt-4.1-mini" };
  let engine = await MobileEngine.open(
    await openDatabase(),
    models,
    settings,
    Date.now,
    workspaceFactory,
  );
  const ids: number[] = [];
  try {
    const chat = await engine.newConversation("Filesystem smoke");
    ids.push(Number(chat.id));
    const receipt = await (
      await engine.submit(
        chat.id,
        "Create, edit and read the test note.",
        "native-file-tools",
      )
    ).wait(engine.context);
    assert(
      receipt.status === "done" && step === (workspaceFactory.shell ? 5 : 4),
      workspaceFactory.shell
        ? "Moose → OpenAI SSE → Pi write/edit/bash/read"
        : "Moose → OpenAI SSE → Pi write/edit/read",
    );
    assert(
      requests[0].includes('"name":"write"') &&
        requests[0].includes('"name":"edit"') &&
        requests[0].includes('"name":"read"') &&
        requests[0].includes('"name":"bash"') === !!workspaceFactory.shell,
      "Only supported tools advertised",
    );
    assert(
      requests[workspaceFactory.shell ? 4 : 3].includes(
        workspaceFactory.shell ? "你好 Moose guest" : "你好 Moose",
      ),
      "Read result reaches the next model request",
    );
    const messages = await engine.messages(chat.id);
    assert(
      messages.length === 2 && messages[1].text === "Filesystem verified",
      "Tool-only events do not create empty chat bubbles",
    );
    const checkpoint = await engine.checkpoint(chat.id, "Files");
    const branch = await engine.restoreCheckpoint(checkpoint.id);
    ids.push(Number(branch.id));
    const branchEnv = workspaceFactory(`moose-chat-${branch.id}`);
    try {
      const missing = await branchEnv.exists("notes/smoke.txt", engine.context);
      assert(
        missing.ok && !missing.value,
        "Checkpoint branch uses a separate workspace",
      );
    } finally {
      await branchEnv.cleanup(engine.context);
    }
    await engine.close();
    engine = await MobileEngine.open(
      await openDatabase(),
      models,
      settings,
      Date.now,
      workspaceFactory,
    );
    const reopened = workspaceFactory(`moose-chat-${chat.id}`);
    try {
      const content = await reopened.readTextFile(
        "notes/smoke.txt",
        engine.context,
      );
      assert(
        content.ok &&
          content.value ===
            (workspaceFactory.shell ? "你好 Moose guest" : "你好 Moose"),
        "File persists across engine / SQLite reopen",
      );
      const rejected = await reopened.writeFile(
        "../escape.txt",
        "blocked",
        engine.context,
      );
      assert(
        !rejected.ok && rejected.error.code === "invalid",
        "Workspace traversal rejected",
      );
    } finally {
      await reopened.cleanup(engine.context);
    }
    assert(
      (await engine.messages(chat.id)).length === 2,
      "Conversation persists with the tool transcript",
    );
    return checks;
  } finally {
    await engine.close();
    // Only the fixture's conversation workspaces; the native caller supplies a smoke prefix.
    for (const id of ids) {
      const env = workspaceFactory(`moose-chat-${id}`);
      try {
        const list = await env.listDir(".", engine.context);
        if (list.ok)
          for (const entry of list.value) {
            const removed = await env.remove(
              entry.path,
              { recursive: true, force: true },
              engine.context,
            );
            if (!removed.ok) throw removed.error;
          }
      } finally {
        await env.cleanup(engine.context);
      }
    }
  }
}
