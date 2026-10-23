import { fetch as nativeFetch } from "expo/fetch";
/** Opt-in, controlled Android native probe. No credentials or real model calls. */
import { Markdown } from "../ui/Markdown";
import { Caption } from "../ui/kit";
import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Pressable,
  SafeAreaView,
  Text,
  View,
} from "react-native";
import { openDatabaseAsync } from "expo-sqlite";
import { createExpoWorkspace } from "pi-durable-expo-env";
import {
  MobileEngine,
  SerialSqliteDatabase,
  createMobileModels,
  executionStatus,
  statusLabel,
} from "../generated/runtime";
import {
  acquireBackground,
  configureBackground,
  cancelInterruptedBackground,
} from "../platform/background";
import { responseEvents, sseResponse } from "./controlled-sse";

let runtime: Promise<MobileEngine> | undefined;
let requests = 0;
const attempts = new Map<string, number>();
function getRuntime() {
  return (runtime ??= (async () => {
    const db = await openDatabaseAsync("background-smoke.sqlite");
    const models = createMobileModels(
      async () => "controlled-fixture-only",
      (async (_url, init) => {
        requests++;
        const bodyText = String(init?.body);
        const probe = /probe=(\d+)/.exec(bodyText)?.[1] ?? "unknown";
        const attempt = (attempts.get(probe) ?? 0) + 1;
        attempts.set(probe, attempt);
        if (
          bodyText.includes("mode=failure") ||
          (bodyText.includes("mode=retry") && attempt === 1)
        ) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          const retry = bodyText.includes("mode=retry");
          return sseResponse(
            `data: ${JSON.stringify({ type: "response.failed", response: { id: "controlled", error: { code: retry ? "server_error" : "invalid_request_error", message: retry ? "Network error" : "Invalid request access_token=fixture-secret" } } })}\n\n`,
          );
        }
        if (String(init?.body).includes("network=1")) {
          console.log(
            "MooseBackgroundSmoke network request",
            requests,
            Date.now(),
          );
          return nativeFetch(
            "http://10.0.2.2:8106/",
            init as never,
          ) as unknown as Response;
        }
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
                const delay = Number(
                  /delay=(\d+)/.exec(String(init?.body))?.[1] ?? 15000,
                );
                await new Promise((resolve) => setTimeout(resolve, delay));
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
    configureBackground((cause) => engine.stopAll(cause), engine);
    await cancelInterruptedBackground((cause) => engine.stopAll(cause));
    await engine.resume();
    return engine;
  })());
}
export function BackgroundSmokeApp() {
  const [preview, setPreview] = useState(false);
  const [status, setStatus] = useState("Opening controlled background probe");
  useEffect(() => {
    void getRuntime()
      .then(async (engine) => {
        const saved = (await engine.listConversations())
          .filter((chat) => chat.title === "Background probe")
          .map((chat) => chat.id);
        if (!saved.length) setStatus("Ready");
        else
          for (const id of saved) {
            const view = await engine.view(id);
            console.log(
              "MooseBackgroundSmoke restored",
              id,
              statusLabel(executionStatus(view)),
            );
          }
        setStatus(`Ready · restored ${saved.length} probes`);
      })
      .catch((e) => setStatus(String(e)));
  }, []);
  async function start(delay = 15000, network = false, mode = "success") {
    try {
      setStatus("Starting");
      const engine = await getRuntime();
      const chat = await engine.newConversation("Background probe");
      const detach = await engine.watch(chat.id, (view) => {
        const label = statusLabel(executionStatus(view));
        setStatus(`${chat.id}: ${label}`);
        console.log("MooseBackgroundSmoke state", chat.id, label, Date.now());
      });
      const submission = await engine.submit(
        chat.id,
        `Controlled file tool delay=${delay} network=${network ? 1 : 0} mode=${mode} probe=${chat.id}`,
        `native-${Date.now()}`,
      );
      setStatus("Running: press Home now");
      const result = await submission.wait(engine.context);
      const text = (await engine.messages(chat.id)).at(-1)?.text;
      const view = await engine.view(chat.id);
      const wrote = view.entries
        .flatMap((entry) => entry.model ?? [])
        .some(
          (message) =>
            message.role === "toolResult" &&
            message.toolName === "write" &&
            !message.isError,
        );
      setStatus(
        result.status === "done" && wrote && text === "Native background passed"
          ? "PASS: SSE, file tool, next round, SQLite"
          : `Stopped: ${result.status}`,
      );
      console.log(
        "MooseBackgroundSmoke result",
        chat.id,
        result.status,
        Date.now(),
      );
      await detach();
    } catch (error) {
      setStatus(String(error));
      console.log("MooseBackgroundSmoke failed", String(error));
    }
  }
  return (
    <SafeAreaView style={{ padding: 30 }}>
      <Text>{status}</Text>
      <Button title="Run background probe" onPress={() => void start()} />
      <Button
        title="Run failure probe"
        onPress={() => void start(15000, false, "failure")}
      />
      <Button
        title="Run retry probe"
        onPress={() => void start(15000, false, "retry")}
      />
      <Button
        title="Run 5 and 10 minute lock probes"
        onPress={() => {
          void start(310000);
          void start(610000);
        }}
      />
      <Button
        title="Run network probe"
        onPress={() => void start(15000, true)}
      />
      <Button
        title="Read saved probe results"
        onPress={() =>
          void getRuntime().then(async (engine) => {
            const ids = (await engine.listConversations())
              .filter((chat) => chat.title === "Background probe")
              .map((chat) => chat.id);
            const results = await Promise.all(
              ids.map(
                async (id) =>
                  `${id}: ${statusLabel(executionStatus(await engine.view(id)))}`,
              ),
            );
            setStatus(results.join("\n"));
          })
        }
      />
      <Button
        title="Preview interruption details"
        onPress={() => setPreview(!preview)}
      />
      {preview && (
        <View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Task status and details"
            onPress={() =>
              Alert.alert(
                "Task details",
                "Completed · 2 retries\nGeneration · network error · recovered",
              )
            }
            style={{ minHeight: 44, justifyContent: "center" }}
          >
            <Caption>Completed · 2 retries · Details</Caption>
          </Pressable>
          <Markdown
            text="An earlier partial answer."
            failure={{
              reason: "error",
              message: "Network error: Software caused connection abort",
              at: Date.UTC(2026, 9, 22, 16),
              phase: "generation",
              retries: 1,
              recovered: true,
            }}
          />
          <Markdown
            text=""
            failure={{
              reason: "budget_expired",
              message: "Background execution budget expired.",
              at: Date.UTC(2026, 9, 22, 16, 30),
              phase: "tool",
              retries: 0,
              recovered: false,
            }}
          />
        </View>
      )}
    </SafeAreaView>
  );
}
