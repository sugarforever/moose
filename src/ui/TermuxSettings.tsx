import React, { useEffect, useState } from "react";
import { Platform, Text, View } from "react-native";
import { termux } from "../platform/termux";
import { Button, Caption, Card, s } from "./kit";
export function TermuxSettings() {
  const [state, setState] = useState<{ enabled: boolean; publicKey: string }>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (Platform.OS === "android")
      void termux
        .status()
        .then(setState)
        .catch((e) => setMessage(String(e)));
  }, []);
  if (Platform.OS !== "android") return null;
  return (
    <Card>
      <Text style={s.heading}>执行环境</Text>
      <Caption>{state?.enabled ? "Termux" : "本地文件"}</Caption>
      <Caption>
        Termux 命令拥有该应用的文件权限。切换后需重新启动 Moose，文件不会迁移。
      </Caption>
      {state && (
        <View>
          <Caption>Termux 服务配对公钥</Caption>
          <Text selectable>{state.publicKey}</Text>
        </View>
      )}
      <Button
        secondary
        label={state?.enabled ? "使用本地文件" : "连接 Termux"}
        busy={busy}
        disabled={!state}
        onPress={() => {
          setBusy(true);
          setMessage("");
          void termux
            .enable(!state?.enabled)
            .then(() => termux.status())
            .then((next) => {
              setState(next);
              setMessage("已保存，请重新启动 Moose。");
            })
            .catch((e) =>
              setMessage(
                e instanceof Error
                  ? e.message
                  : "连接失败，请检查 Termux 服务。",
              ),
            )
            .finally(() => setBusy(false));
        }}
      />
      {!!message && <Caption>{message}</Caption>}
    </Card>
  );
}
