import React, { useEffect, useRef, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  ActivityIndicator,
  Keyboard,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  SafeAreaProvider,
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { setToolsButtonVisible } from "expo-dev-client";
import { useMoose } from "./src/ui/useMoose";
import { useAndroidUpdates } from "./src/ui/updates";
import { TasksScreen, SkillsScreen, SettingsScreen } from "./src/ui/screens";
import {
  Button,
  Caption,
  Icon,
  IconButton,
  colors,
  s,
  type IconName,
} from "./src/ui/kit";
import { Artifacts, CapabilityApproval } from "./src/ui/Artifacts";
import type { ChatMessage } from "./src/runtime/engine";
import type { ActivityMessage } from "./src/ui/chat-activity";
import { ActivityRow } from "./src/ui/ActivityRow";

type Tab = "chat" | "tasks" | "skills" | "settings";
const tabs: { id: Tab; label: string; icon: IconName }[] = [
  { id: "chat", label: "Chat", icon: "message-circle" },
  { id: "tasks", label: "Tasks", icon: "layers" },
  { id: "skills", label: "Skills", icon: "grid" },
  { id: "settings", label: "Settings", icon: "sliders" },
];

export default function App() {
  useEffect(() => {
    if (__DEV__) setToolsButtonVisible(false);
  }, []);
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <MooseApp />
    </SafeAreaProvider>
  );
}
function MooseApp() {
  const moose = useMoose();
  const updates = useAndroidUpdates();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>("chat");
  const [text, setText] = useState("");
  const [history, setHistory] = useState(false);
  const [artifactsVisible, setArtifactsVisible] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const followBottom = useRef(true);
  const list = useRef<FlatList<ActivityMessage>>(null);
  const title =
    moose.conversations.find((item) => item.id === moose.conversationId)
      ?.title ?? "New conversation";
  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      () => setKeyboardVisible(true),
    );
    const hide = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => setKeyboardVisible(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  useEffect(() => {
    followBottom.current = true;
  }, [moose.conversationId]);
  const messageMenu = (item: ChatMessage) => {
    if (
      item.role !== "user" ||
      moose.busy ||
      moose.working ||
      moose.pending ||
      !moose.hasCredentials
    )
      return;
    const resend = () => {
      void moose.send(item.text);
    };
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ["Resend", "Cancel"], cancelButtonIndex: 1 },
        (index) => {
          if (index === 0) resend();
        },
      );
    } else {
      Alert.alert("Message", undefined, [
        { text: "Resend", onPress: resend },
        { text: "Cancel", style: "cancel" },
      ]);
    }
  };
  const conversationMenu = () => {
    const artifacts = () => {
      void moose.refreshArtifacts();
      setArtifactsVisible(true);
    };
    const save = () => {
      void moose.checkpoint();
    };
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ["Save checkpoint", "Files and reports", "Cancel"],
          cancelButtonIndex: 2,
          disabledButtonIndices: moose.busy ? [0] : [],
        },
        (index) => {
          if (index === 0 && !moose.busy) save();
          if (index === 1) artifacts();
        },
      );
    } else {
      Alert.alert("Chat", undefined, [
        ...(!moose.busy ? [{ text: "Save checkpoint", onPress: save }] : []),
        { text: "Files and reports", onPress: artifacts },
        { text: "Cancel", style: "cancel" },
      ]);
    }
  };
  const canSubmit =
    !!text.trim() &&
    !!moose.runtime &&
    !!moose.conversationId &&
    moose.hasCredentials &&
    !moose.busy &&
    !moose.working &&
    !moose.pending;
  const submit = () => {
    if (!canSubmit) return;
    const value = text;
    setText("");
    followBottom.current = true;
    void moose.send(value);
  };
  return (
    <SafeAreaView
      style={a.safe}
      edges={
        keyboardVisible
          ? ["top", "left", "right"]
          : ["top", "left", "right", "bottom"]
      }
    >
      <CapabilityApproval approval={moose.approval} />
      <Artifacts
        moose={moose}
        visible={artifactsVisible}
        onClose={() => setArtifactsVisible(false)}
      />
      <View style={a.shell}>
        <View style={a.header}>
          {tab === "chat" ? (
            <>
              <IconButton
                name="clock"
                label="Chat history"
                disabled={moose.working}
                onPress={() => {
                  Keyboard.dismiss();
                  setHistory(true);
                }}
              />
              <View style={a.navigationTitle}>
                <Text numberOfLines={1} style={a.conversationTitle}>
                  {moose.messages.length
                    ? title === "New conversation"
                      ? "New conversation"
                      : title
                    : "New conversation"}
                </Text>
                {moose.hasCredentials && (
                  <Text numberOfLines={1} style={a.meta}>
                    {moose.settings.modelId}
                  </Text>
                )}
              </View>
              <IconButton
                name="plus"
                label="New conversation"
                disabled={!moose.runtime || moose.working}
                onPress={() => void moose.newChat()}
              />
              {moose.messages.length > 0 && (
                <IconButton
                  name="more-horizontal"
                  label="Conversation options"
                  onPress={conversationMenu}
                />
              )}
            </>
          ) : (
            <Text style={a.brandName}>moose</Text>
          )}
        </View>
        {!!updates.state?.update && tab !== "settings" && (
          <Pressable
            accessibilityRole="button"
            onPress={() => setTab("settings")}
            style={{ paddingHorizontal: 20, paddingVertical: 10 }}
          >
            <Text style={s.link}>
              Version {updates.state.update.version} available. View update
            </Text>
          </Pressable>
        )}
        {!!moose.error && (
          <View style={a.error}>
            <Icon name="alert-circle" size={16} color={colors.danger} />
            <Text selectable style={a.errorText}>
              {moose.error}
            </Text>
            {!moose.runtime && (
              <Button
                secondary
                label="Retry opening"
                busy={moose.working}
                onPress={() => void moose.retryRuntime()}
              />
            )}
            <IconButton
              name="x"
              label="Dismiss"
              onPress={() => {
                if (moose.runtime) moose.setError("");
              }}
            />
          </View>
        )}
        {!moose.runtime && !moose.error && !moose.working ? (
          <View
            style={{
              flex: 1,
              justifyContent: "center",
              alignItems: "center",
              gap: 14,
            }}
          >
            <ActivityIndicator color={colors.green} />
          </View>
        ) : tab === "chat" ? (
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : undefined}
            keyboardVerticalOffset={insets.top}
            style={{ flex: 1 }}
          >
            <FlatList
              ref={list}
              data={moose.messages}
              keyExtractor={(item, index) =>
                item.activity?.id ?? `${item.entryId}:${index}`
              }
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode={
                Platform.OS === "ios" ? "interactive" : "on-drag"
              }
              onScroll={({
                nativeEvent: { contentOffset, contentSize, layoutMeasurement },
              }) => {
                followBottom.current =
                  contentSize.height -
                    contentOffset.y -
                    layoutMeasurement.height <
                  80;
              }}
              scrollEventThrottle={16}
              onLayout={() => {
                if (followBottom.current)
                  list.current?.scrollToEnd({ animated: false });
              }}
              contentContainerStyle={[
                a.messages,
                moose.messages.length === 0 && {
                  flexGrow: 1,
                  justifyContent: "center",
                },
              ]}
              onContentSizeChange={() =>
                followBottom.current &&
                list.current?.scrollToEnd({ animated: true })
              }
              ListEmptyComponent={
                !moose.hasCredentials ? (
                  <View style={{ alignItems: "center" }}>
                    <Button
                      label="Connect model"
                      onPress={() => setTab("settings")}
                    />
                  </View>
                ) : undefined
              }
              renderItem={({ item }) =>
                item.activity ? (
                  <View style={[a.message, a.assistantMessage]}>
                    <ActivityRow activity={item.activity} />
                  </View>
                ) : (
                  <Pressable
                    onLongPress={
                      item.role === "user" ? () => messageMenu(item) : undefined
                    }
                    delayLongPress={400}
                    accessible={item.role === "user"}
                    accessibilityLabel={`${item.role === "user" ? "You" : "Moose"}: ${item.text}`}
                    accessibilityActions={
                      item.role === "user" &&
                      !moose.busy &&
                      !moose.working &&
                      !moose.pending &&
                      moose.hasCredentials
                        ? [{ name: "messageMenu", label: "Message options" }]
                        : undefined
                    }
                    onAccessibilityAction={({ nativeEvent }) => {
                      if (nativeEvent.actionName === "messageMenu")
                        messageMenu(item);
                    }}
                    style={[
                      a.message,
                      item.role === "user" ? a.userMessage : a.assistantMessage,
                    ]}
                  >
                    <Text
                      selectable={item.role !== "user"}
                      style={[
                        a.messageText,
                        item.error && { color: colors.danger },
                      ]}
                    >
                      {item.text || (item.error ? "Response interrupted" : "…")}
                    </Text>
                  </Pressable>
                )
              }
              ListFooterComponent={
                moose.busy || moose.activity.length ? (
                  <View style={[a.message, a.assistantMessage]}>
                    {moose.activity.map((activity) => (
                      <ActivityRow
                        key={`${moose.conversationId}:${activity.id}`}
                        activity={activity}
                      />
                    ))}
                    {!!moose.partial && moose.busy && (
                      <Text selectable style={a.messageText}>
                        {moose.partial}
                      </Text>
                    )}
                  </View>
                ) : undefined
              }
            />
            {moose.pending && !moose.working && (
              <View style={a.retry}>
                <Caption>A request needs confirmation</Caption>
                <Pressable
                  accessibilityRole="button"
                  onPress={() =>
                    void moose.send(moose.pending!.text, moose.pending!)
                  }
                  style={{ padding: 10 }}
                >
                  <Text style={s.link}>Retry</Text>
                </Pressable>
              </View>
            )}
            <View style={a.composerArea}>
              <View style={a.composer}>
                <TextInput
                  accessibilityLabel="Message"
                  value={text}
                  onChangeText={setText}
                  placeholder="Message"
                  placeholderTextColor="#929C95"
                  multiline
                  style={a.input}
                  editable={!moose.working}
                />
                {moose.busy ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Stop response"
                    onPress={() => void moose.stop()}
                    style={a.send}
                  >
                    <Icon name="square" size={17} color="#fff" />
                  </Pressable>
                ) : (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Send message"
                    disabled={!canSubmit}
                    onPress={submit}
                    style={[
                      a.send,
                      !canSubmit && {
                        opacity: 0.35,
                      },
                    ]}
                  >
                    <Icon name="arrow-up" size={21} color="#fff" />
                  </Pressable>
                )}
              </View>
            </View>
          </KeyboardAvoidingView>
        ) : tab === "tasks" ? (
          <TasksScreen moose={moose} />
        ) : tab === "skills" ? (
          <SkillsScreen moose={moose} />
        ) : (
          <SettingsScreen moose={moose} updates={updates.controller} />
        )}
        {!keyboardVisible && (
          <View style={a.tabs}>
            {tabs.map((item) => (
              <Pressable
                accessibilityRole="tab"
                accessibilityLabel={item.label}
                accessibilityState={{ selected: tab === item.id }}
                key={item.id}
                onPress={() => setTab(item.id)}
                style={a.tab}
              >
                <View
                  style={[
                    a.tabIcon,
                    tab === item.id && { backgroundColor: colors.soft },
                  ]}
                >
                  <Icon
                    name={item.icon}
                    size={20}
                    color={tab === item.id ? colors.green : colors.muted}
                  />
                </View>
                <Text
                  style={[
                    a.tabLabel,
                    tab === item.id && {
                      color: colors.green,
                      fontWeight: "600",
                    },
                  ]}
                >
                  {item.label}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
        <Modal
          visible={history}
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => setHistory(false)}
        >
          <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
            <View style={[s.between, { padding: 20 }]}>
              <Text style={s.heading}>Chat history</Text>
              <IconButton
                name="x"
                label="Close chat history"
                onPress={() => setHistory(false)}
              />
            </View>
            <ScrollView contentContainerStyle={{ padding: 20, gap: 10 }}>
              {moose.conversations.map((chat) => (
                <Pressable
                  key={chat.id}
                  accessibilityRole="button"
                  onPress={() => {
                    moose.selectConversation(chat.id);
                    setTab("chat");
                    setHistory(false);
                  }}
                  style={[
                    a.historyItem,
                    chat.id === moose.conversationId && {
                      borderColor: colors.green,
                    },
                  ]}
                >
                  <Icon name="message-circle" />
                  <Text style={{ color: colors.ink, flex: 1 }}>
                    {chat.title === "New conversation"
                      ? "New conversation"
                      : chat.title}
                  </Text>
                  <Icon name="chevron-right" size={16} />
                </Pressable>
              ))}
            </ScrollView>
          </SafeAreaView>
        </Modal>
      </View>
    </SafeAreaView>
  );
}
const a = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  shell: { flex: 1, width: "100%", maxWidth: 760, alignSelf: "center" },
  header: {
    minHeight: 52,
    paddingHorizontal: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  brandName: {
    fontSize: 20,
    fontWeight: "600",
    color: colors.ink,
    paddingHorizontal: 8,
  },
  navigationTitle: { flex: 1, gap: 2, paddingHorizontal: 4 },
  conversationTitle: { fontSize: 17, fontWeight: "600", color: colors.ink },
  meta: { fontSize: 11, color: colors.muted },
  messages: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    gap: 14,
  },
  message: { maxWidth: "100%" },
  userMessage: {
    alignSelf: "flex-end",
    minHeight: 44,
    justifyContent: "center",
    maxWidth: "88%",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: colors.soft,
  },
  assistantMessage: { alignSelf: "stretch", paddingVertical: 2 },
  messageText: { fontSize: 16, lineHeight: 23, color: colors.ink },
  composerArea: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 6 },
  composer: {
    borderWidth: 1,
    borderColor: "#D9E1D5",
    backgroundColor: "#fff",
    borderRadius: 23,
    flexDirection: "row",
    alignItems: "flex-end",
    padding: 2,
    gap: 4,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    paddingTop: 12,
    paddingBottom: 12,
    paddingHorizontal: 10,
    fontSize: 15,
    color: colors.ink,
  },
  send: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.green,
    alignItems: "center",
    justifyContent: "center",
  },
  tabs: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderColor: colors.line,
    paddingTop: 2,
    paddingBottom: 2,
    backgroundColor: colors.bg,
  },
  tab: { flex: 1, alignItems: "center", gap: 1, minHeight: 48 },
  tabIcon: {
    width: 54,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  tabLabel: { fontSize: 10, color: colors.muted },
  error: {
    margin: 12,
    paddingLeft: 12,
    backgroundColor: "#F8ECE8",
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  errorText: { flex: 1, color: colors.danger, fontSize: 12, lineHeight: 19 },
  retry: {
    paddingHorizontal: 20,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  historyItem: {
    minHeight: 65,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 17,
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
    backgroundColor: "#fff",
  },
});
