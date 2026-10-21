import React, { useState } from "react";
import { Modal, Text, View, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { Button, Caption, colors, s } from "./kit";
import type { Moose } from "./useMoose";
import type { Artifact } from "../capabilities/service";
import { artifactPreview } from "../capabilities/artifact-preview";
import type { Approval } from "../platform/capabilities";
import { permissionLabel } from "../platform/capabilities";

export function CapabilityApproval({
  approval,
}: {
  approval: Approval | undefined;
}) {
  return (
    <Modal
      visible={!!approval}
      transparent
      animationType="fade"
      onRequestClose={() => approval?.resolve(false)}
    >
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          padding: 24,
          backgroundColor: "#0006",
        }}
      >
        <View
          style={{
            padding: 20,
            gap: 16,
            backgroundColor: colors.paper,
            borderRadius: 16,
          }}
        >
          <Text style={s.subheading}>允许访问？</Text>
          <Text style={s.caption}>
            {approval?.title} · {approval?.skillName}
          </Text>
          <Text style={{ color: colors.ink }}>
            {approval ? permissionLabel(approval.permission) : ""}
          </Text>
          <Caption>授权仅在当前对话的所示范围内生效，可在设置中撤销。</Caption>
          <Button label="允许" onPress={() => approval?.resolve(true)} />
          <Button
            label="拒绝"
            secondary
            onPress={() => approval?.resolve(false)}
          />
        </View>
      </View>
    </Modal>
  );
}
export function Artifacts({
  moose,
  visible,
  onClose,
}: {
  moose: Moose;
  visible: boolean;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Artifact>();
  const [loading, setLoading] = useState(false);
  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={() => {
        setSelected(undefined);
        onClose();
      }}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.paper }}>
        <View style={[s.between, { padding: 16 }]}>
          <Text style={s.subheading}>{selected?.title ?? "文件与报告"}</Text>
          <Button
            label="关闭"
            secondary
            onPress={() => {
              setSelected(undefined);
              onClose();
            }}
          />
        </View>
        {selected ? (
          <>
            <View style={{ paddingHorizontal: 16, paddingBottom: 12, gap: 8 }}>
              <Button
                label="返回列表"
                secondary
                onPress={() => setSelected(undefined)}
              />
              <Button
                label="分享或导出"
                onPress={() => void moose.shareArtifact(selected)}
              />
            </View>
            <WebView
              source={{ html: artifactPreview(selected.text, selected.mime) }}
              originWhitelist={["*"]}
              javaScriptEnabled={false}
              javaScriptCanOpenWindowsAutomatically={false}
              domStorageEnabled={false}
              allowFileAccess={false}
              allowFileAccessFromFileURLs={false}
              allowUniversalAccessFromFileURLs={false}
              mixedContentMode="never"
              incognito
              setSupportMultipleWindows={false}
              onShouldStartLoadWithRequest={(request) =>
                request.url === "about:blank"
              }
              onOpenWindow={() => {}}
              dataDetectorTypes="none"
              allowsLinkPreview={false}
              onError={() => moose.setError("无法预览此文件")}
            />
          </>
        ) : (
          <ScrollView contentContainerStyle={[s.page, { gap: 12 }]}>
            {moose.artifacts.length === 0 && <Caption>暂无文件或报告</Caption>}
            {moose.artifacts.map((a) => (
              <Button
                key={a.ref}
                label={a.title}
                secondary
                disabled={loading}
                onPress={() => {
                  setLoading(true);
                  void moose
                    .openArtifact(a.ref)
                    .then((result) => {
                      if (result) setSelected(result);
                    })
                    .finally(() => setLoading(false));
                }}
              />
            ))}
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}
