import React, { useEffect, useState, useSyncExternalStore } from "react";
import { AppState, Text, View } from "react-native";
import { createAndroidUpdates } from "../platform/updates";
import { Button, Caption, Card, s } from "./kit";
import type { UpdateController } from "../updates/controller";

export function useAndroidUpdates() {
  const [controller] = useState(createAndroidUpdates);
  const state = useSyncExternalStore(
    controller?.subscribe ?? (() => () => {}),
    controller?.getSnapshot ?? (() => undefined),
  );
  useEffect(() => {
    if (!controller) return;
    void controller.check();
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void controller.check();
    });
    return () => {
      subscription.remove();
      controller.cancel();
    };
  }, [controller]);
  return { controller, state };
}

export function AndroidUpdates({
  controller,
  blocked,
}: {
  controller?: UpdateController;
  blocked: boolean;
}) {
  const state = useSyncExternalStore(
    controller?.subscribe ?? (() => () => {}),
    controller?.getSnapshot ?? (() => undefined),
  );
  if (!controller || !state) return null;
  const busy = ["checking", "downloading", "verifying", "installing"].includes(
    state.status,
  );
  const downloadable =
    state.update && ["available", "error"].includes(state.status);
  return (
    <Card>
      <Text style={s.subheading}>应用更新</Text>
      <Caption>
        当前版本 {controller.platform.version}（
        {controller.platform.versionCode}）
      </Caption>
      {state.update && (
        <View style={{ gap: 8 }}>
          <Text style={s.subheading}>
            新版本 {state.update.version}（{state.update.versionCode}）
          </Text>
          {!!state.update.notes && <Text selectable>{state.update.notes}</Text>}
        </View>
      )}
      {state.status === "downloading" && (
        <Caption>正在下载 {Math.floor(state.progress * 100)}%</Caption>
      )}
      {state.status === "verifying" && <Caption>正在校验安装包</Caption>}
      {!!state.message && <Caption>{state.message}</Caption>}
      {downloadable && (
        <Button
          label="下载更新"
          icon="download"
          onPress={() => void controller.download()}
        />
      )}
      {state.status === "ready" && (
        <>
          {blocked && <Caption>请等待当前操作结束后安装</Caption>}
          <Button
            label="安装更新"
            icon="download"
            disabled={blocked}
            onPress={() => void controller.install()}
          />
        </>
      )}
      {busy && state.status !== "installing" && (
        <Button secondary label="取消" onPress={controller.cancel} />
      )}
      {!busy && state.status !== "ready" && (
        <Button
          secondary
          label="检查更新"
          onPress={() => void controller.check(true)}
        />
      )}
      {state.status === "checking" && <Caption>正在检查更新</Caption>}
    </Card>
  );
}
