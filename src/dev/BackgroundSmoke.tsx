/** Opt-in, controlled Android native probe. No credentials or real model calls. */
import { useEffect, useState } from "react";
import { Button, SafeAreaView, Text } from "react-native";
import { openDatabaseAsync } from "expo-sqlite";
import { createExpoWorkspace } from "pi-durable-expo-env";
import {
  MobileEngine,
  SerialSqliteDatabase,
  createMobileModels,
} from "../generated/runtime";
import {
  acquireBackground,
  configureBackground,
  cancelInterruptedBackground,
} from "../platform/background";
import { responseEvents, sseResponse } from "./controlled-sse";

let runtime: Promise<MobileEngine> | undefined;
let requests = 0;
function getRuntime() {
  return (runtime ??= (async () => {
    const db = await openDatabaseAsync("background-smoke.sqlite");
    const models = createMobileModels(
      async () => "controlled-fixture-only",
      (async (_url, init) => {
        requests++;
        const input = JSON.parse(String(init?.body)).input as {
          type: string;
        }[];
        const step = input.some((item) => item.type === "function_call_output")
          ? 1
          : 0;
        console.log("MooseBackgroundSmoke request", requests);
        if (step === 0) {
          // Start the original response now; continue consuming while Activity is hidden.
          const body = responseEvents(0, [
            {
              name: "write",
              arguments: {
                path: "background.txt",
                content: "native background tool",
              },
            },
          ]);
          const response = new Response("", {
            headers: { "content-type": "text/event-stream" },
          });
          Object.defineProperty(response, "body", {
            value: new ReadableStream({
              async start(controller) {
                controller.enqueue(new TextEncoder().encode(body.slice(0, 50)));
                await new Promise((resolve) => setTimeout(resolve, 15000));
                if ((init?.signal as AbortSignal | undefined)?.aborted) {
                  controller.error(new Error("cancelled"));
                  return;
                }
                controller.enqueue(new TextEncoder().encode(body.slice(50)));
                controller.close();
              },
            }),
          });
          return response;
        }
        if (!String(init?.body).includes("native background tool"))
          throw new Error("Missing tool result");
        return sseResponse(responseEvents(1, [], "Native background passed"));
      }) as typeof fetch,
    );
    const engine = await MobileEngine.open(
      new SerialSqliteDatabase(db),
      models,
      { provider: "openai", modelId: "gpt-4.1-mini" },
      Date.now,
      (id) => createExpoWorkspace({ workspaceId: `background-smoke-${id}` }),
      undefined,
      {},
      acquireBackground,
    );
    configureBackground(() => engine.stopAll());
    await cancelInterruptedBackground(() => engine.stopAll());
    return engine;
  })());
}
export function BackgroundSmokeApp() {
  const [status, setStatus] = useState("Opening controlled background probe");
  useEffect(() => {
    void getRuntime()
      .then(() => setStatus("Ready"))
      .catch((e) => setStatus(String(e)));
  }, []);
  async function start() {
    try {
      setStatus("Starting");
      const engine = await getRuntime();
      const chat = await engine.newConversation("Background probe");
      const submission = await engine.submit(
        chat.id,
        "Controlled file tool",
        `native-${Date.now()}`,
      );
      setStatus("Running: press Home now");
      const result = await submission.wait(engine.context);
      const text = (await engine.messages(chat.id)).at(-1)?.text;
      setStatus(
        result.status === "done" && text === "Native background passed"
          ? "PASS: SSE, file tool, next round, SQLite"
          : `Stopped: ${result.status}`,
      );
      console.log("MooseBackgroundSmoke result", result.status);
    } catch (error) {
      setStatus(String(error));
      console.log("MooseBackgroundSmoke failed", String(error));
    }
  }
  return (
    <SafeAreaView style={{ padding: 30 }}>
      <Text>{status}</Text>
      <Button title="Run background probe" onPress={() => void start()} />
    </SafeAreaView>
  );
}
