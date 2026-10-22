/** Opt-in real Android Termux probe; controlled model transport, no account access. */
import { useEffect, useState } from "react";
import { AppState, Button, SafeAreaView, Text } from "react-native";
import { openDatabaseAsync } from "expo-sqlite";
import {
  MobileEngine,
  SerialSqliteDatabase,
  createMobileModels,
} from "../generated/runtime";
import { termux } from "../platform/termux";
import { acquireBackground, configureBackground } from "../platform/background";
import { readyExecution, observeTermuxRecovery } from "../termux/recovery";
import { responseEvents, sseResponse } from "./controlled-sse";
let engine: Promise<MobileEngine> | undefined;
let requests = 0;
function getEngine() {
  return (engine ??= (async () => {
    const factory = await termux.factory();
    if (!factory) throw new Error("Connect Termux first");
    const models = createMobileModels(
      async () => "controlled-fixture-only",
      (async (_url, init) => {
        requests++;
        const input = JSON.parse(String(init?.body)).input as {
          type: string;
        }[];
        const step = input.filter(
          (item) => item.type === "function_call_output",
        ).length;
        if (step === 2 && !String(init?.body).includes("termux-recovery-ok"))
          throw new Error("Missing real shell result");
        return sseResponse(
          responseEvents(
            step,
            [
              {
                name: "write",
                arguments: {
                  path: "recovery.txt",
                  content: "termux-recovery-ok",
                },
              },
              { name: "bash", arguments: { command: "cat recovery.txt" } },
            ],
            "Termux recovery passed",
          ),
        );
      }) as typeof fetch,
    );
    const runtime = await MobileEngine.open(
      new SerialSqliteDatabase(
        await openDatabaseAsync("termux-recovery-smoke.sqlite"),
      ),
      models,
      { provider: "openai", modelId: "gpt-4.1-mini" },
      Date.now,
      factory,
      undefined,
      { shell: true },
      readyExecution(acquireBackground, termux.ensureReady),
    );
    configureBackground(() => runtime.stopAll());
    return runtime;
  })());
}
export function TermuxRecoverySmokeApp() {
  const [status, setStatus] = useState(
    "Connect Termux, then run controlled tools",
  );
  useEffect(
    () =>
      observeTermuxRecovery(AppState, termux.ensureReady, (error) =>
        setStatus(String(error)),
      ),
    [],
  );
  const run = async (setup: boolean) => {
    try {
      setStatus(setup ? "Connecting" : "Running controlled tools");
      if (setup) {
        await termux.enable(true, new AbortController().signal, (phase) =>
          setStatus(phase),
        );
        setStatus("Connected");
      } else {
        const runtime = await getEngine();
        const chat = await runtime.newConversation("Termux recovery probe");
        const result = await (
          await runtime.submit(
            chat.id,
            "Controlled Termux write and bash",
            `termux-native-${Date.now()}`,
          )
        ).wait(runtime.context);
        const text = (await runtime.messages(chat.id)).at(-1)?.text;
        if (result.status !== "done" || text !== "Termux recovery passed")
          throw new Error(`Tools failed: ${result.status}`);
        setStatus(
          `PASS: real Termux write/bash, same Harness; controlled requests ${requests}`,
        );
      }
    } catch (error) {
      setStatus(String(error));
    }
  };
  return (
    <SafeAreaView style={{ padding: 30 }}>
      <Text>{status}</Text>
      <Button title="Connect Termux" onPress={() => void run(true)} />
      <Button
        title="Check without repair"
        onPress={() => {
          setStatus("Checking without repair");
          void termux
            .selfTest(new AbortController().signal, () => {})
            .then(
              () => setStatus("PASS: signed self-test"),
              (error) => setStatus(String(error)),
            );
        }}
      />
      <Button title="Run controlled tools" onPress={() => void run(false)} />
    </SafeAreaView>
  );
}
