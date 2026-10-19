import { useEffect, useState } from "react";
import { ScrollView, Text } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { openDatabaseAsync, deleteDatabaseAsync } from "expo-sqlite";
import { createExpoWorkspace } from "pi-durable-expo-env";
import { SerialSqliteDatabase } from "../generated/runtime";
import { runFileSmoke } from "./files-smoke";

/** Explicit developer entry. Never opens the user's database or credentials. */
export function FilesSmokeApp() {
  const [status, setStatus] = useState(
    "Running filesystem integration checks…",
  );
  useEffect(() => {
    void (async () => {
      try {
        const previous = await openDatabaseAsync("moose-files-smoke.sqlite");
        await previous.closeAsync();
        await deleteDatabaseAsync("moose-files-smoke.sqlite");
        const checks = await runFileSmoke(
          async () =>
            new SerialSqliteDatabase(
              await openDatabaseAsync("moose-files-smoke.sqlite"),
            ),
          (workspaceId) =>
            createExpoWorkspace({ workspaceId: `smoke-${workspaceId}` }),
        );
        const result = `Moose filesystem smoke passed\n\n${checks.map((check) => `✓ ${check}`).join("\n")}`;
        console.log(result);
        setStatus(result);
      } catch (error) {
        const result = `Moose filesystem smoke FAILED\n${error instanceof Error ? error.stack : String(error)}`;
        console.error(result);
        setStatus(result);
      }
    })();
  }, []);
  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: "#f7f8f6" }}>
        <ScrollView contentContainerStyle={{ padding: 24 }}>
          <Text selectable style={{ fontSize: 17, lineHeight: 28 }}>
            {status}
          </Text>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
