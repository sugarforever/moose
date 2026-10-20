import React, { useEffect, useState } from "react";
import {
  Image,
  Linking,
  Pressable,
  ScrollView,
  Switch,
  Text,
  View,
} from "react-native";
import {
  Button,
  Caption,
  Card,
  Field,
  Icon,
  IconButton,
  colors,
  s,
} from "./kit";
import { permissionLabel } from "../platform/capabilities";
import type { Moose } from "./useMoose";

export function TasksScreen({ moose }: { moose: Moose }) {
  const [prompt, setPrompt] = useState("");
  const [minutes, setMinutes] = useState("60");
  const [count, setCount] = useState("3");
  const [creating, setCreating] = useState(false);
  return (
    <ScrollView
      contentContainerStyle={s.page}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ gap: 6 }}>
        <Text style={s.heading}>任务</Text>
      </View>
      <Card>
        <View style={s.row}>
          <Icon name="repeat" />
          <Text style={s.subheading}>重复任务</Text>
        </View>
        <Field label="指令" value={prompt} onChangeText={setPrompt} multiline />
        <View style={s.row}>
          <View style={{ flex: 1 }}>
            <Field
              label="间隔（分钟）"
              keyboardType="number-pad"
              value={minutes}
              onChangeText={setMinutes}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Field
              label="次数"
              keyboardType="number-pad"
              value={count}
              onChangeText={setCount}
            />
          </View>
        </View>
        <Caption>仅在前台执行，每次调用模型。</Caption>
        <Button
          label="创建任务"
          icon="plus"
          busy={creating}
          disabled={!prompt.trim() || !moose.runtime}
          onPress={() => {
            setCreating(true);
            void moose
              .repeat(prompt, Number(minutes), Number(count))
              .finally(() => setCreating(false));
          }}
        />
      </Card>
      {moose.tasks.map((task) => (
        <Card key={task.id}>
          <View style={s.between}>
            <Text style={s.subheading}>重复任务 #{task.id}</Text>
            <Text style={{ fontSize: 12, color: colors.muted }}>
              {task.status === "terminal"
                ? task.outcome === "completed"
                  ? "已完成"
                  : task.outcome === "aborted"
                    ? "已停止"
                    : "执行失败"
                : "待执行"}
            </Text>
          </View>
          <Text style={{ color: colors.ink, lineHeight: 23 }}>
            {task.input.prompt}
          </Text>
          <Caption>
            {task.completed} / {task.input.count} 次已完成 · 间隔{" "}
            {task.input.intervalMs / 60000} 分钟
            {task.at ? `\n下次：${new Date(task.at).toLocaleString()}` : ""}
          </Caption>
          {task.status !== "terminal" && (
            <Button
              label="停止重复"
              secondary
              onPress={() => void moose.stopTask(task.id)}
            />
          )}
        </Card>
      ))}
      <View style={s.between}>
        <Text style={s.subheading}>检查点</Text>
        <Text style={{ color: colors.muted }}>{moose.checkpoints.length}</Text>
      </View>
      {moose.checkpoints.length === 0 ? (
        <Card>
          <Caption>暂无检查点</Caption>
        </Card>
      ) : (
        moose.checkpoints
          .slice()
          .reverse()
          .map((item) => (
            <Card key={item.id}>
              <View style={s.row}>
                <Icon name="bookmark" />
                <View style={{ flex: 1 }}>
                  <Text style={s.subheading}>{item.label}</Text>
                  <Caption>{new Date(item.createdAt).toLocaleString()}</Caption>
                </View>
              </View>
              <Button
                label="从这里继续"
                secondary
                icon="git-branch"
                onPress={() => void moose.restore(item.id)}
              />
            </Card>
          ))
      )}
    </ScrollView>
  );
}

export function SkillsScreen({ moose }: { moose: Moose }) {
  const [url, setUrl] = useState("");
  const [installing, setInstalling] = useState(false);
  const [preview, setPreview] = useState<string>();
  return (
    <ScrollView
      contentContainerStyle={s.page}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ gap: 6 }}>
        <Text style={s.heading}>Skills</Text>
      </View>
      <Card>
        <Field
          label="Skill 链接"
          placeholder="https://…"
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <Caption>仅加载指令，不执行脚本。</Caption>
        <Button
          label="安装"
          icon="download"
          busy={installing}
          disabled={!url.trim() || !moose.runtime}
          onPress={() => {
            setInstalling(true);
            void moose.install(url).finally(() => setInstalling(false));
          }}
        />
      </Card>
      <View style={s.between}>
        <Text style={s.subheading}>已安装</Text>
        <Caption>{moose.selected.length} 项已启用</Caption>
      </View>
      {moose.skills.length === 0 ? (
        <Caption>暂无 Skill</Caption>
      ) : (
        moose.skills.map((skill) => (
          <Card key={skill.id}>
            <View style={s.between}>
              <View style={{ flex: 1, gap: 6 }}>
                <Text style={s.subheading}>{skill.name}</Text>
                <Text numberOfLines={2} style={s.caption}>
                  {skill.description}
                </Text>
              </View>
              <Switch
                accessibilityLabel={`启用 ${skill.name}`}
                value={moose.selected.includes(skill.id)}
                onValueChange={() => void moose.toggleSkill(skill.id)}
                trackColor={{ true: colors.green, false: colors.line }}
              />
            </View>
            <View style={s.between}>
              <Pressable
                accessibilityRole="button"
                onPress={() =>
                  setPreview(preview === skill.id ? undefined : skill.id)
                }
                style={{ minHeight: 44, justifyContent: "center" }}
              >
                <Text style={s.link}>
                  {preview === skill.id ? "收起内容" : "查看指令"}
                </Text>
              </Pressable>
              <IconButton
                name="trash-2"
                label={`卸载 ${skill.name}`}
                onPress={() => void moose.removeSkill(skill.id)}
              />
            </View>
            {preview === skill.id && (
              <Text
                selectable
                style={{ color: colors.muted, fontSize: 12, lineHeight: 20 }}
              >
                {skill.instructions}
              </Text>
            )}
          </Card>
        ))
      )}
    </ScrollView>
  );
}

export function SettingsScreen({ moose }: { moose: Moose }) {
  const [provider, setProvider] = useState(moose.settings.provider);
  const [model, setModel] = useState(moose.settings.modelId);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const models = moose.runtime?.models.getModels(provider) ?? [];
  useEffect(() => {
    void moose.refreshGrants();
  }, [moose.runtime, moose.conversationId]);
  return (
    <ScrollView
      contentContainerStyle={s.page}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ gap: 6 }}>
        <Text style={s.heading}>设置</Text>
      </View>
      <Card>
        <Text style={s.subheading}>当前对话权限</Text>
        {moose.grants.length === 0 ? (
          <Caption>暂无授权</Caption>
        ) : (
          moose.grants.map((grant) => (
            <View
              key={`${grant.skillId}:${grant.permission}`}
              style={{ gap: 4 }}
            >
              <Text style={s.caption}>
                {moose.skills.find((s) => s.id === grant.skillId)?.name ??
                  "已卸载 Skill"}
              </Text>
              <Caption>{permissionLabel(grant.permission)}</Caption>
            </View>
          ))
        )}
        {moose.grants.length > 0 && (
          <Button
            label="撤销全部授权"
            secondary
            onPress={() => void moose.revokeGrants()}
          />
        )}
      </Card>
      {provider === "openai-codex" && <ChatGPTConnection moose={moose} />}
      <Card>
        <View style={s.row}>
          {["openai", "anthropic", "openai-codex"].map((id) => (
            <View key={id} style={{ flex: 1 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  id === "openai"
                    ? "OpenAI"
                    : id === "anthropic"
                      ? "Anthropic"
                      : "ChatGPT"
                }
                accessibilityState={{ selected: provider === id }}
                style={({ pressed }) => ({
                  minHeight: 48,
                  borderRadius: 10,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: provider === id ? colors.green : colors.soft,
                  opacity: pressed ? 0.7 : 1,
                })}
                onPress={() => {
                  setProvider(id);
                  setModel(
                    id === "openai"
                      ? "gpt-4.1-mini"
                      : id === "anthropic"
                        ? "claude-sonnet-4-5"
                        : "gpt-5.6-luna",
                  );
                  setKey("");
                }}
              >
                <Image
                  source={
                    id === "openai"
                      ? require("../../assets/brands/openai.png")
                      : id === "anthropic"
                        ? require("../../assets/brands/anthropic.png")
                        : require("../../assets/brands/chatgpt.png")
                  }
                  resizeMode="contain"
                  accessible={false}
                  style={{
                    width: id === "openai" ? 68 : 26,
                    height: 26,
                    tintColor: provider === id ? "#fff" : colors.green,
                  }}
                />
              </Pressable>
            </View>
          ))}
        </View>
        <Field
          label="模型"
          value={model}
          onChangeText={setModel}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable
          accessibilityRole="button"
          onPress={() => setShowModels(!showModels)}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text style={s.link}>{showModels ? "收起模型列表" : "选择模型"}</Text>
        </Pressable>
        {showModels && (
          <View style={{ gap: 2, maxHeight: 240 }}>
            <ScrollView nestedScrollEnabled>
              {models
                .filter(
                  (item) =>
                    !model ||
                    item.id.toLowerCase().includes(model.toLowerCase()),
                )
                .slice(0, 50)
                .map((item) => (
                  <Pressable
                    key={item.id}
                    accessibilityRole="button"
                    style={{
                      paddingVertical: 13,
                      borderBottomWidth: 1,
                      borderColor: colors.line,
                    }}
                    onPress={() => {
                      setModel(item.id);
                      setShowModels(false);
                    }}
                  >
                    <Text style={{ color: colors.ink }}>{item.id}</Text>
                  </Pressable>
                ))}
              <Pressable
                onPress={() => setModel("")}
                style={{ paddingVertical: 14 }}
              >
                <Text style={s.link}>清除筛选，显示所有模型</Text>
              </Pressable>
            </ScrollView>
          </View>
        )}
        {provider !== "openai-codex" && (
          <Field
            label="API Key"
            placeholder={
              provider === moose.settings.provider && moose.hasCredentials
                ? "已保存，留空以继续使用"
                : "输入你的 API Key"
            }
            value={key}
            onChangeText={setKey}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
        )}
        {provider !== "openai-codex" && <Caption>API 单独计费</Caption>}
        <Button
          label={"保存"}
          icon="check"
          busy={saving}
          disabled={
            !moose.runtime ||
            (provider === "openai-codex" && !moose.codexStatus.connected)
          }
          onPress={() => {
            setSaving(true);
            void moose
              .saveSettings({ provider, modelId: model }, key)
              .finally(() => {
                setSaving(false);
                setKey("");
              });
          }}
        />
        {moose.hasCredentials &&
          provider === moose.settings.provider &&
          provider !== "openai-codex" && (
            <View style={s.between}>
              <View style={s.row}>
                <Icon name="check-circle" size={15} color={colors.green} />
                <Caption>{moose.settings.provider} 密钥已保存</Caption>
              </View>
              <Pressable
                accessibilityRole="button"
                onPress={() => void moose.removeKey()}
                style={{ minHeight: 44, justifyContent: "center" }}
              >
                <Text style={{ color: colors.danger, fontSize: 12 }}>
                  移除密钥
                </Text>
              </Pressable>
            </View>
          )}
      </Card>
    </ScrollView>
  );
}

function ChatGPTConnection({ moose }: { moose: Moose }) {
  const { chatGPTLogin: login, codexStatus: status } = moose;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (login.phase !== "waiting") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [login.phase]);
  const active = login.phase === "waiting" || login.phase === "requesting";
  const seconds = Math.max(
    0,
    Math.ceil(((login.challenge?.expiresAt ?? now) - now) / 1000),
  );
  return (
    <Card>
      <View style={s.row}>
        <Text style={s.subheading}>ChatGPT · 实验性</Text>
      </View>
      {status.connected && (
        <View style={{ gap: 8 }}>
          <View style={s.row}>
            <Icon name="check-circle" size={17} />
            <Text style={{ color: colors.green, fontWeight: "600" }}>
              已登录
            </Text>
          </View>
        </View>
      )}
      {login.phase === "waiting" && login.challenge && (
        <View
          style={{
            gap: 13,
            padding: 16,
            borderRadius: 15,
            backgroundColor: colors.soft,
          }}
        >
          <Caption>在授权页输入设备码</Caption>
          <Text
            selectable
            accessibilityLabel={`设备码 ${login.challenge.userCode}`}
            style={{
              fontSize: 27,
              fontWeight: "700",
              letterSpacing: 3,
              color: colors.ink,
              textAlign: "center",
            }}
          >
            {login.challenge.userCode}
          </Text>
          <Caption>
            {seconds > 0
              ? `剩余 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒，正在等待授权。`
              : "设备码已过期，请重新发起。"}
          </Caption>
          <Button
            label="打开授权页"
            icon="external-link"
            onPress={() =>
              void moose.run(() =>
                Linking.openURL("https://auth.openai.com/codex/device"),
              )
            }
          />
        </View>
      )}
      {login.phase === "error" && (
        <Text
          accessibilityRole="alert"
          style={{ color: colors.danger, fontSize: 13, lineHeight: 21 }}
        >
          {login.error}
        </Text>
      )}
      {login.phase === "waiting" && login.method === "browser" && (
        <Caption>等待浏览器授权…</Caption>
      )}
      {!active && (
        <Button
          label={status.connected ? "重新登录" : "登录 ChatGPT"}
          icon="external-link"
          disabled={!moose.runtime}
          onPress={() => void moose.startChatGPTLogin("browser")}
        />
      )}
      {!active && (
        <Button
          label={status.connected ? "设备码登录" : "设备码登录"}
          secondary
          disabled={!moose.runtime}
          onPress={() => void moose.startChatGPTLogin()}
        />
      )}
      {login.phase === "requesting" && (
        <View style={s.row}>
          <Caption>
            {login.method === "browser" ? "正在打开登录…" : "正在申请设备码"}
          </Caption>
        </View>
      )}
      {active && (
        <Button label="取消登录" secondary onPress={moose.cancelChatGPTLogin} />
      )}
      {status.connected && !active && (
        <Button
          label="退出登录"
          secondary
          icon="log-out"
          onPress={() => void moose.logoutChatGPT()}
        />
      )}
      <Pressable
        accessibilityRole="link"
        onPress={() =>
          void moose.run(() =>
            Linking.openURL("https://learn.chatgpt.com/docs/auth"),
          )
        }
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <Text style={s.link}>登录帮助</Text>
      </Pressable>
    </Card>
  );
}
