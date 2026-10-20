import React, { useEffect, useState, useSyncExternalStore } from "react";
import { ScrollView, Text, View, Button } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { openDatabaseAsync, deleteDatabaseAsync } from "expo-sqlite";
import { WebView } from "react-native-webview";
import { SerialSqliteDatabase } from "../generated/runtime";
import { runCapabilitySmoke } from "./capabilities-smoke";
import { artifactPreview } from "../capabilities/artifact-preview";
import { CapabilityApproval } from "../ui/Artifacts";
import { approvals } from "../platform/capabilities";
import { shareArtifact } from "../platform/capabilities";
import type { Artifact } from "../capabilities/service";

export function CapabilitiesSmokeApp() {
  const approval = useSyncExternalStore(approvals.subscribe, approvals.get);
  const [status, setStatus] = useState(
    "Running native capability checks......",
  );
  const [artifact, setArtifact] = useState<Artifact>();
  useEffect(() => {
    void (async () => {
      try {
        const initialized = new Set<string>();
        const result = await runCapabilitySmoke(async (key) => {
          const filename = `moose-capabilities-smoke-${key}.sqlite`;
          if (!initialized.has(filename)) {
            const previous = await openDatabaseAsync(filename);
            await previous.closeAsync();
            await deleteDatabaseAsync(filename);
            initialized.add(filename);
          }
          return new SerialSqliteDatabase(await openDatabaseAsync(filename));
        });
        setArtifact(result.artifact);
        setStatus(
          `Capability smoke passed\n${result.checks.map((c) => `✓ ${c}`).join("\n")}`,
        );
      } catch (error) {
        setStatus(
          `Capability smoke FAILED\n${error instanceof Error ? error.stack : String(error)}`,
        );
      }
    })();
  }, []);
  return (
    <SafeAreaProvider>
      <CapabilityApproval approval={approval} />
      <SafeAreaView style={{ flex: 1 }}>
        <ScrollView
          style={{ maxHeight: 460 }}
          contentContainerStyle={{ padding: 16 }}
        >
          <Text selectable>{status}</Text>
        </ScrollView>
        <Button
          title="Test conversation permission"
          onPress={() =>
            void approvals
              .request(
                {
                  conversationId: 3,
                  skillId: "",
                  permission: "http:https://example.com",
                  signal: new AbortController().signal,
                },
                "Moose · 当前对话",
                "Native scope smoke",
              )
              .then((allow) =>
                setStatus(
                  (status) =>
                    `${status}\n${allow ? "✓" : "Denied"} Conversation permission dialog`,
                ),
              )
          }
        />
        {artifact && (
          <>
            <Button
              title="Share native report"
              onPress={() => void shareArtifact(artifact)}
            />
            <View style={{ flex: 1 }}>
              <WebView
                source={{ html: artifactPreview(artifact.text, artifact.mime) }}
                originWhitelist={["*"]}
                javaScriptEnabled={false}
                domStorageEnabled={false}
                allowFileAccess={false}
                allowFileAccessFromFileURLs={false}
                allowUniversalAccessFromFileURLs={false}
                mixedContentMode="never"
                incognito
                onShouldStartLoadWithRequest={(r) => r.url === "about:blank"}
                javaScriptCanOpenWindowsAutomatically={false}
                setSupportMultipleWindows={false}
                onOpenWindow={() => {}}
                dataDetectorTypes="none"
                allowsLinkPreview={false}
              />
            </View>
          </>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
