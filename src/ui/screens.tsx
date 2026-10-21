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
import { TermuxSettings } from "./TermuxSettings";
import { permissionLabel } from "../platform/capabilities";
import type { Moose } from "./useMoose";
import { AndroidUpdates } from "./updates";
import type { UpdateController } from "../updates/controller";

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
        <Text style={s.heading}>Tasks</Text>
      </View>
      <Card>
        <View style={s.row}>
          <Icon name="repeat" />
          <Text style={s.subheading}>Repeating task</Text>
        </View>
        <Field
          label="Instructions"
          value={prompt}
          onChangeText={setPrompt}
          multiline
        />
        <View style={s.row}>
          <View style={{ flex: 1 }}>
            <Field
              label="Interval (minutes)"
              keyboardType="number-pad"
              value={minutes}
              onChangeText={setMinutes}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Field
              label="Count"
              keyboardType="number-pad"
              value={count}
              onChangeText={setCount}
            />
          </View>
        </View>
        <Caption>Runs in the foreground. Each run calls the model.</Caption>
        <Button
          label="Create task"
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
            <Text style={s.subheading}>Repeating task #{task.id}</Text>
            <Text style={{ fontSize: 12, color: colors.muted }}>
              {task.status === "terminal"
                ? task.outcome === "completed"
                  ? "Completed"
                  : task.outcome === "aborted"
                    ? "Stopped"
                    : "Failed"
                : "Pending"}
            </Text>
          </View>
          <Text style={{ color: colors.ink, lineHeight: 23 }}>
            {task.input.prompt}
          </Text>
          <Caption>
            {task.completed} / {task.input.count} completed · Every{" "}
            {task.input.intervalMs / 60000} minutes
            {task.at
              ? `\nNext: ${new Date(task.at).toLocaleString("en-GB")}`
              : ""}
          </Caption>
          {task.status !== "terminal" && (
            <Button
              label="Stop repeating"
              secondary
              onPress={() => void moose.stopTask(task.id)}
            />
          )}
        </Card>
      ))}
      <View style={s.between}>
        <Text style={s.subheading}>Checkpoints</Text>
        <Text style={{ color: colors.muted }}>{moose.checkpoints.length}</Text>
      </View>
      {moose.checkpoints.length === 0 ? (
        <Card>
          <Caption>No checkpoints</Caption>
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
                  <Caption>
                    {new Date(item.createdAt).toLocaleString("en-GB")}
                  </Caption>
                </View>
              </View>
              <Button
                label="Continue from here"
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
          label="Skill URL"
          placeholder="https://…"
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <Caption>Loads instructions only. Scripts are not run.</Caption>
        <Button
          label="Install"
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
        <Text style={s.subheading}>Installed</Text>
        <Caption>{moose.selected.length} enabled</Caption>
      </View>
      {moose.skills.length === 0 ? (
        <Caption>No skills</Caption>
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
                accessibilityLabel={`Enable ${skill.name}`}
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
                  {preview === skill.id ? "Hide content" : "View instructions"}
                </Text>
              </Pressable>
              <IconButton
                name="trash-2"
                label={`Uninstall ${skill.name}`}
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

export function SettingsScreen({
  moose,
  updates,
}: {
  moose: Moose;
  updates?: UpdateController;
}) {
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
        <Text style={s.heading}>Settings</Text>
      </View>
      <TermuxSettings moose={moose} />
      <Card>
        <Text style={s.subheading}>
          Native tool access for this conversation
        </Text>
        {moose.runtime?.executionEnvironment === "termux" && (
          <Caption>
            These permissions apply to native tools. Termux commands retain file
            and network access.
          </Caption>
        )}
        {moose.grants.length === 0 ? (
          <Caption>No permissions granted</Caption>
        ) : (
          moose.grants.map((grant) => (
            <View
              key={`${grant.skillId}:${grant.permission}`}
              style={{ gap: 4 }}
            >
              <Text style={s.caption}>
                {grant.skillId
                  ? (moose.skills.find((s) => s.id === grant.skillId)?.name ??
                    "Uninstalled skill")
                  : "Moose · Current conversation"}
              </Text>
              <Caption>{permissionLabel(grant.permission)}</Caption>
            </View>
          ))
        )}
        {moose.grants.length > 0 && (
          <Button
            label="Revoke all access"
            secondary
            onPress={() => void moose.revokeGrants()}
          />
        )}
      </Card>
      {provider === "openai-codex" && <ChatGPTConnection moose={moose} />}
      <AndroidUpdates
        controller={updates}
        blocked={moose.busy || moose.working}
      />
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
          label="Model"
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
          <Text style={s.link}>
            {showModels ? "Hide model list" : "Choose model"}
          </Text>
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
                <Text style={s.link}>Clear filters and show all models</Text>
              </Pressable>
            </ScrollView>
          </View>
        )}
        {provider !== "openai-codex" && (
          <Field
            label="API Key"
            placeholder={
              provider === moose.settings.provider && moose.hasCredentials
                ? "Saved. Leave blank to keep using it."
                : "Enter your API key"
            }
            value={key}
            onChangeText={setKey}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
        )}
        {provider !== "openai-codex" && (
          <Caption>API usage is billed separately</Caption>
        )}
        <Button
          label={"Save"}
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
                <Caption>{moose.settings.provider} API key saved</Caption>
              </View>
              <Pressable
                accessibilityRole="button"
                onPress={() => void moose.removeKey()}
                style={{ minHeight: 44, justifyContent: "center" }}
              >
                <Text style={{ color: colors.danger, fontSize: 12 }}>
                  Remove API key
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
        <Text style={s.subheading}>ChatGPT · Experimental</Text>
      </View>
      {status.connected && (
        <View style={{ gap: 8 }}>
          <View style={s.row}>
            <Icon name="check-circle" size={17} />
            <Text style={{ color: colors.green, fontWeight: "600" }}>
              Signed in
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
          <Caption>Enter the device code on the authorization page</Caption>
          <Text
            selectable
            accessibilityLabel={`Device code ${login.challenge.userCode}`}
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
              ? `Waiting for authorization. ${Math.floor(seconds / 60)}m ${seconds % 60}s remaining.`
              : "The device code expired. Start again."}
          </Caption>
          <Button
            label="Open authorization page"
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
        <Caption>Waiting for browser authorization…</Caption>
      )}
      {!active && (
        <Button
          label={status.connected ? "Sign in again" : "Sign in to ChatGPT"}
          icon="external-link"
          disabled={!moose.runtime}
          onPress={() => void moose.startChatGPTLogin("browser")}
        />
      )}
      {!active && (
        <Button
          label={
            status.connected
              ? "Sign in with device code"
              : "Sign in with device code"
          }
          secondary
          disabled={!moose.runtime}
          onPress={() => void moose.startChatGPTLogin()}
        />
      )}
      {login.phase === "requesting" && (
        <View style={s.row}>
          <Caption>
            {login.method === "browser"
              ? "Opening sign-in…"
              : "Requesting device code"}
          </Caption>
        </View>
      )}
      {active && (
        <Button
          label="Cancel sign-in"
          secondary
          onPress={moose.cancelChatGPTLogin}
        />
      )}
      {status.connected && !active && (
        <Button
          label="Sign out"
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
        <Text style={s.link}>Sign-in help</Text>
      </Pressable>
    </Card>
  );
}
