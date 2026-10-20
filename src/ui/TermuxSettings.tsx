import React, { useEffect, useRef, useState } from "react";
import { AppState, Platform, Text } from "react-native";
import { termux, termuxSetupCommand } from "../platform/termux";
import type { SetupPhase } from "../termux/setup";
import type { Moose } from "./useMoose";
import { Button, Caption, Card, s } from "./kit";
const phases: Record<SetupPhase, string> = {
  checking: "检查 Termux 和服务版本",
  installing: "安装依赖并部署服务，请稍候",
  connecting: "连接 Termux 服务",
  ready: "连接已建立，正在切换环境",
};
export function TermuxSettings({ moose }: { moose: Moose }) {
  const [state, setState] =
    useState<Awaited<ReturnType<typeof termux.status>>>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const refresh = async () => {
    try {
      const value = await termux.status();
      if (mounted.current) setState(value);
    } catch (error) {
      if (mounted.current)
        setMessage(error instanceof Error ? error.message : "无法检查 Termux");
    }
  };
  useEffect(() => {
    mounted.current = true;
    if (Platform.OS === "android") void refresh();
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active" && !controller.current && Platform.OS === "android")
        void refresh();
    });
    return () => {
      mounted.current = false;
      controller.current?.abort();
      sub.remove();
    };
  }, []);
  if (Platform.OS !== "android") return null;
  const active = moose.runtime?.executionEnvironment === "termux";
  const act = async (operation: () => Promise<unknown>) => {
    try {
      setMessage("");
      await operation();
      await refresh();
    } catch (error) {
      if (mounted.current)
        setMessage(error instanceof Error ? error.message : "操作失败");
    }
  };
  async function change(enabled: boolean) {
    const next = new AbortController();
    controller.current = next;
    setBusy(true);
    setMessage("");
    try {
      await moose.changeExecutionEnvironment(enabled, next.signal, (phase) => {
        if (mounted.current && !next.signal.aborted) setMessage(phases[phase]);
      });
      if (mounted.current)
        setMessage(enabled ? "已连接 Termux。" : "已切换到本地文件。");
    } catch (error) {
      if (mounted.current)
        setMessage(
          next.signal.aborted
            ? "已取消等待。已安装的依赖不会回滚。"
            : error instanceof Error
              ? error.message
              : "连接失败，请重试。",
        );
    } finally {
      controller.current = null;
      if (mounted.current) {
        setBusy(false);
        await refresh();
      }
    }
  }
  return (
    <Card>
      <Text style={s.heading}>执行环境</Text>
      <Caption>{active ? "Termux" : "本地文件"}</Caption>
      <Caption>
        Termux 命令拥有该应用的文件和网络权限。切换不会迁移文件。
      </Caption>
      {!state?.installed && <Caption>请先安装并打开一次 Termux。</Caption>}
      <Button
        secondary
        label="打开 Termux"
        disabled={busy}
        onPress={() => void act(termux.openTermux)}
      />
      {state?.installed && !state.granted && (
        <>
          <Button
            secondary
            label="授权运行命令"
            disabled={busy}
            onPress={() => void act(termux.requestPermission)}
          />
          <Button
            secondary
            label="打开系统设置"
            disabled={busy}
            onPress={() => void act(termux.openSettings)}
          />
        </>
      )}
      {!active && (
        <>
          <Caption>
            首次使用：在 Termux 中执行以下命令，然后返回此页。长按命令可复制。
          </Caption>
          <Text selectable>{termuxSetupCommand}</Text>
          <Button
            label="设置并连接 Termux"
            busy={busy}
            disabled={
              !state?.installed || !moose.runtime || (moose.working && !busy)
            }
            onPress={() => void change(true)}
          />
        </>
      )}
      {active && (
        <>
          <Button
            secondary
            label="检查或修复连接"
            busy={busy}
            disabled={!moose.runtime}
            onPress={() => void change(true)}
          />
          <Button
            secondary
            label="使用本地文件"
            disabled={busy || moose.working || !moose.runtime}
            onPress={() => void change(false)}
          />
        </>
      )}
      {busy && (
        <Button
          secondary
          label="取消设置"
          onPress={() => controller.current?.abort()}
        />
      )}
      {!!message && <Caption>{message}</Caption>}
    </Card>
  );
}
