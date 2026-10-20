import React, { useEffect, useState } from "react";
import { ScrollView, Text, View, Button } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { openDatabaseAsync, deleteDatabaseAsync } from "expo-sqlite";
import { WebView } from "react-native-webview";
import { SerialSqliteDatabase } from "../generated/runtime";
import { runCapabilitySmoke } from "./capabilities-smoke";
import { artifactPreview } from "../capabilities/artifact-preview";
import { shareArtifact } from "../platform/capabilities";
import type { Artifact } from "../capabilities/service";

export function CapabilitiesSmokeApp() {
  const [status, setStatus] = useState(
    "Running native capability checks......",
  );
  const [artifact, setArtifact] = useState<Artifact>();
  useEffect(() => {
    void (async () => {
      try {
        const filename = "moose-capabilities-smoke.sqlite";
        const old = await openDatabaseAsync(filename);
        await old.closeAsync();
        await deleteDatabaseAsync(filename);
        const result = await runCapabilitySmoke(
          async () =>
            new SerialSqliteDatabase(await openDatabaseAsync(filename)),
        );
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
      <SafeAreaView style={{ flex: 1 }}>
        <ScrollView
          style={{ maxHeight: 460 }}
          contentContainerStyle={{ padding: 16 }}
        >
          <Text selectable>{status}</Text>
        </ScrollView>
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
