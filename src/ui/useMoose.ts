import { observeTermuxRecovery } from "../termux/recovery";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AppState, Linking } from "react-native";
import { conversationLink } from "./conversation-link";
import { randomUUID } from "expo-crypto";
import { fetch as nativeFetch } from "expo/fetch";
import { termux } from "../platform/termux";
import {
  getMobileRuntime,
  recoverMobileRuntime,
  changeMobileEnvironment,
  RuntimeUnavailable,
} from "../platform/runtime-owner";
import { acquireBackground } from "../platform/background";
import type { SetupPhase } from "../termux/setup";
import { credentials, defaultSettings } from "../platform/open";
import {
  loadSkill,
  chatMessages,
  executionStatus,
  executionDetails,
  statusLabel,
} from "../generated/runtime";
import type {
  MobileEngine,
  ModelSettings,
  SavedCheckpoint,
} from "../runtime/engine";
import type { Skill } from "../skills/skills";
import {
  chatActivity,
  toolMessages,
  type Activity,
  type ActivityMessage,
} from "./chat-activity";
import type { ExecutionStatus } from "../runtime/execution-diagnostics";
import type { LiveState } from "@earendil-works/pi-durable";
import { codexAuth } from "../platform/codex";
import { loginCodexBrowser } from "../platform/codex-browser";
import {
  approvals,
  shareArtifact as exportArtifact,
} from "../platform/capabilities";
import type { Artifact } from "../capabilities/service";
import type { Grant } from "../capabilities/permissions";
import type { CodexStatus, DeviceChallenge } from "../auth/codex";

export type ChatGPTLogin = {
  phase: "idle" | "requesting" | "waiting" | "saved" | "error";
  method?: "device" | "browser";
  challenge?: Pick<
    DeviceChallenge,
    "userCode" | "verificationUri" | "expiresAt"
  >;
  error?: string;
};

type Runtime = Awaited<ReturnType<typeof getMobileRuntime>>;
export type Pending = {
  conversationId: number;
  text: string;
  requestId: string;
};
export function useMoose() {
  const approval = useSyncExternalStore(approvals.subscribe, approvals.get);
  const [artifacts, setArtifacts] = useState<Omit<Artifact, "text">[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [runtime, setRuntime] = useState<Runtime>();
  const appMounted = useRef(true);
  const [settings, setSettings] = useState<ModelSettings>(defaultSettings);
  const [conversationId, setConversationId] = useState<number>();
  const [notificationRoute, setNotificationRoute] = useState<{
    id: number;
    sequence: number;
  }>();
  const [notificationNavigation, setNotificationNavigation] = useState(0);
  useEffect(() => {
    let sequence = 0;
    let disposed = false;
    const receive = (url: string | null | undefined) => {
      const id = conversationLink(url ?? null);
      if (!disposed && id) setNotificationRoute({ id, sequence: ++sequence });
    };
    const subscription = Linking.addEventListener("url", ({ url }) =>
      receive(url),
    );
    void Linking.getInitialURL()
      .then((url) => {
        if (!sequence) receive(url);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      subscription.remove();
    };
  }, []);
  useEffect(() => {
    if (!runtime || !notificationRoute) return;
    let disposed = false;
    void run(async () => {
      const chats = await runtime.engine.listConversations();
      if (disposed) return;
      setNotificationRoute(undefined);
      if (!chats.some((chat) => chat.id === notificationRoute.id)) return;
      setConversations(chats);
      setConversationId(notificationRoute.id);
      setNotificationNavigation((value) => value + 1);
    });
    return () => {
      disposed = true;
    };
  }, [runtime, notificationRoute]);

  const [conversations, setConversations] = useState<
    { id: number; title: string }[]
  >([]);
  const [messages, setMessages] = useState<ActivityMessage[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [partial, setPartial] = useState("");
  const [executionDetail, setExecutionDetail] = useState("");
  const [execution, setExecution] = useState<ExecutionStatus>({
    state: "idle",
    retries: 0,
  });
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [checkpoints, setCheckpoints] = useState<SavedCheckpoint[]>([]);
  const [tasks, setTasks] = useState<
    Awaited<ReturnType<MobileEngine["tasks"]>>
  >([]);
  const [hasCredentials, setHasCredentials] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const inFlight = useRef(false);
  const [codexStatus, setCodexStatus] = useState<CodexStatus>({
    connected: false,
  });
  const [chatGPTLogin, setChatGPTLogin] = useState<ChatGPTLogin>({
    phase: "idle",
  });
  const loginController = useRef<AbortController | null>(null);
  const refresh = useCallback(async (engine: MobileEngine) => {
    const [chats, installed, saved, repeats, subscription] = await Promise.all([
      engine.listConversations(),
      engine.read<Skill[]>("skills", []),
      engine.read<SavedCheckpoint[]>("checkpoints", []),
      engine.tasks(),
      codexAuth.status(),
    ]);
    setConversations(chats);
    setSkills(installed);
    setCheckpoints(saved);
    setTasks(repeats);
    setCodexStatus(subscription);
  }, []);
  const run = useCallback(async (operation: () => Promise<unknown>) => {
    try {
      setError("");
      await operation();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Operation failed. Try again.",
      );
    }
  }, []);
  useEffect(() => {
    let disposed = false;
    appMounted.current = true;
    void run(async () => {
      const next = await getMobileRuntime();
      if (disposed) return;
      const savedSettings = await next.engine.read<ModelSettings>(
        "settings",
        defaultSettings,
      );
      setSettings(savedSettings);
      const key = await credentials.has(savedSettings.provider);
      setHasCredentials(!!key);
      await refresh(next.engine);
      const chats = await next.engine.listConversations();
      const saved = await next.engine.read<number | null>(
        "activeConversation",
        null,
      );
      const id =
        chats.find((chat) => chat.id === saved)?.id ??
        chats[0]?.id ??
        Number((await next.engine.newConversation()).id);
      setConversationId(id);
      setRuntime(next);
      await recoverMobileRuntime(next);
    });
    return () => {
      disposed = true;
      appMounted.current = false;
      loginController.current?.abort();
    };
  }, [refresh, run]);
  useEffect(() => {
    if (!runtime || !conversationId) return;
    let disposed = false;
    let stop: (() => Promise<unknown>) | undefined;
    setArtifacts([]);
    setGrants([]);
    setMessages([]);
    setPartial("");
    setActivity([]);
    setBusy(false);
    setExecution({ state: "idle", retries: 0 });
    setExecutionDetail("");
    void run(async () => {
      const [activeSkills, outbox] = await Promise.all([
        runtime.engine.read<string[]>(`skills:${conversationId}`, []),
        runtime.engine.pendingRequest(conversationId),
      ]);
      if (disposed) return;
      setSelected(activeSkills);
      setPending(outbox);
      await runtime.engine.write("activeConversation", conversationId);
      const detach = await runtime.engine.watch(conversationId, (view) => {
        if (disposed) return;
        const next = [...chatMessages(view), ...toolMessages(view)].sort(
          (a, b) => a.entryId - b.entryId,
        );
        setMessages(next);
        setExecution(executionStatus(view));
        setExecutionDetail(executionDetails(view));
        const live = view.docs["pi.live"] as unknown as LiveState | undefined;
        setBusy(!!live?.run);
        setActivity(chatActivity(live));
        setPartial(
          live?.generation?.message?.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("") ?? "",
        );
      });
      stop = detach;
      if (disposed) await detach();
    });
    return () => {
      disposed = true;
      if (stop) void stop().catch(() => {});
    };
  }, [runtime, conversationId, run]);
  useEffect(() => {
    if (!runtime) return;
    const stopRecovery = observeTermuxRecovery(
      AppState,
      termux.ensureReady,
      (cause) => {
        setError(
          cause instanceof Error
            ? cause.message
            : "Check or repair Termux in Settings.",
        );
      },
    );
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void run(async () => {
          const ready = await credentials.has(settings.provider);
          setHasCredentials(ready);
          await refresh(runtime.engine);
        });
      }
    });
    // Views subscribe to state; foreground transitions never reopen or resume a Harness.
    const timer = setInterval(() => {
      if (AppState.currentState === "active")
        void (async () => {
          await refresh(runtime.engine);
          if (conversationId)
            setPending(await runtime.engine.pendingRequest(conversationId));
        })().catch(() => {});
    }, 3000);
    return () => {
      stopRecovery();
      subscription.remove();
      clearInterval(timer);
    };
  }, [runtime, settings.provider, conversationId, refresh, run]);
  async function send(text: string, retry?: Pending) {
    if (!runtime || !conversationId || inFlight.current) return;
    if (!hasCredentials) {
      setError("Add an API key or sign in to ChatGPT in Settings first.");
      return;
    }
    if (!text.trim()) return;
    if (pending && !retry) {
      setError(
        "Resolve the pending request first by retrying with the same ID.",
      );
      return;
    }
    inFlight.current = true;
    setWorking(true);
    const item = retry ?? {
      conversationId,
      text: text.trim(),
      requestId: randomUUID(),
    };
    await run(async () => {
      const lease = await acquireBackground();
      try {
        await runtime.engine.prepareConversation(item.conversationId, settings);
        await runtime.engine.write(`outbox:${item.conversationId}`, item);
        setPending(item);
        const submission = await runtime.engine.submit(
          item.conversationId,
          item.text,
          item.requestId,
        );
        const result = await submission.wait(runtime.engine.context);
        await runtime.engine.write(`outbox:${item.conversationId}`, null);
        setPending(null);
        if (result.status !== "done") {
          const ready = await credentials.has(settings.provider);
          setHasCredentials(ready);
          if (settings.provider === "openai-codex") {
            setCodexStatus(await codexAuth.status());
            if (!ready)
              throw new Error(
                "Your ChatGPT session has expired. Sign in again in Settings.",
              );
          }
          // The committed task status and attempt details explain the outcome.
          // Do not add a second generic error that outlives a recovered attempt.
          return;
        }
        if (messages.length === 0)
          await runtime.engine.write(
            `title:${item.conversationId}`,
            item.text.slice(0, 30),
          );
        await refresh(runtime.engine);
      } finally {
        await lease.release();
      }
    });
    inFlight.current = false;
    setWorking(false);
  }
  return {
    approval,
    artifacts,
    grants,
    refreshArtifacts: async () => {
      if (runtime && conversationId)
        await run(async () =>
          setArtifacts(
            (await runtime.engine.capabilities?.artifacts(conversationId)) ??
              [],
          ),
        );
    },
    openArtifact: async (ref: string) => {
      if (!runtime || !conversationId) return;
      try {
        return await runtime.engine.capabilities?.artifact(conversationId, ref);
      } catch {
        setError("Cannot open this file.");
      }
    },
    shareArtifact: (artifact: Artifact) => run(() => exportArtifact(artifact)),
    refreshGrants: async () => {
      if (runtime && conversationId)
        await run(async () =>
          setGrants(await runtime.permissions.list(conversationId)),
        );
    },
    revokeGrants: () =>
      run(async () => {
        if (runtime && conversationId) {
          await runtime.engine.stopConversation(conversationId);
          await runtime.permissions.revoke(conversationId);
          setGrants([]);
        }
      }),
    runtime,
    changeExecutionEnvironment: async (
      enabled: boolean,
      signal: AbortSignal,
      onPhase: (phase: SetupPhase) => void,
    ) => {
      if (!runtime || inFlight.current)
        throw new Error("Wait for the current operation to finish.");
      inFlight.current = true;
      setWorking(true);
      setError("");
      try {
        const changed = await changeMobileEnvironment(enabled, signal, onPhase);
        if (!appMounted.current) return;
        setRuntime(changed.runtime);
        setSettings(changed.runtime.settings);
        await refresh(changed.runtime.engine);
        await recoverMobileRuntime(changed.runtime);
        if (changed.error) throw changed.error;
      } catch (error) {
        if (appMounted.current) {
          if (error instanceof RuntimeUnavailable) setRuntime(undefined);
          setError(
            error instanceof Error
              ? error.message
              : "Switch failed. Try reopening the runtime.",
          );
        }
        throw error;
      } finally {
        inFlight.current = false;
        if (appMounted.current) setWorking(false);
      }
    },
    retryRuntime: async () => {
      if (inFlight.current || runtime) return;
      inFlight.current = true;
      setWorking(true);
      setError("");
      try {
        const next = await getMobileRuntime();
        if (!appMounted.current) return;
        setRuntime(next);
        setSettings(next.settings);
        await refresh(next.engine);
        const chats = await next.engine.listConversations();
        setConversationId(
          chats.find((chat) => chat.id === conversationId)?.id ??
            chats[0]?.id ??
            Number((await next.engine.newConversation()).id),
        );
        setHasCredentials(await credentials.has(next.settings.provider));
        await recoverMobileRuntime(next);
      } catch (error) {
        if (appMounted.current)
          setError(
            error instanceof Error
              ? error.message
              : "Cannot open the runtime. Try again.",
          );
      } finally {
        inFlight.current = false;
        if (appMounted.current) setWorking(false);
      }
    },
    settings,
    conversationId,
    notificationNavigation,
    conversations,
    messages,
    partial,
    activity,
    busy,
    executionNeedsReview: execution.unknownEffects,
    executionDetail,
    acknowledgeUnknownEffects: () =>
      run(async () => {
        if (!runtime || !conversationId) return;
        await runtime.engine.acknowledgeUnknownEffects(conversationId);
        setExecution(
          executionStatus(await runtime.engine.view(conversationId)),
        );
      }),
    executionLabel: statusLabel(
      approval?.conversationId === conversationId
        ? { ...execution, state: "waiting_authorization" }
        : execution,
    ),
    working,
    error,
    setError,
    skills,
    selected,
    checkpoints,
    tasks,
    hasCredentials,
    codexStatus,
    chatGPTLogin,
    startChatGPTLogin: async (method: "device" | "browser" = "device") => {
      loginController.current?.abort();
      const controller = new AbortController();
      loginController.current = controller;
      setChatGPTLogin({ phase: "requesting", method });
      try {
        if (method === "browser") {
          await loginCodexBrowser(controller.signal, () => {
            if (!controller.signal.aborted)
              setChatGPTLogin({ phase: "waiting", method });
          });
        } else {
          const challenge = await codexAuth.begin(controller.signal);
          if (controller.signal.aborted) return;
          setChatGPTLogin({
            phase: "waiting",
            challenge: {
              userCode: challenge.userCode,
              verificationUri: challenge.verificationUri,
              expiresAt: challenge.expiresAt,
            },
          });
          await codexAuth.complete(challenge, controller.signal);
        }
        if (controller.signal.aborted) return;
        setCodexStatus(await codexAuth.status());
        setChatGPTLogin({ phase: "saved" });
        if (settings.provider === "openai-codex") setHasCredentials(true);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setChatGPTLogin({
          phase: "error",
          error:
            cause instanceof Error
              ? cause.message
              : "Authorization failed. Try again.",
        });
      } finally {
        if (loginController.current === controller)
          loginController.current = null;
      }
    },
    cancelChatGPTLogin: () => {
      loginController.current?.abort();
      loginController.current = null;
      codexAuth.cancelPending();
      setChatGPTLogin({ phase: "idle" });
    },
    logoutChatGPT: () =>
      run(async () => {
        loginController.current?.abort();
        loginController.current = null;
        await codexAuth.logout();
        setCodexStatus({ connected: false });
        setChatGPTLogin({ phase: "idle" });
        if (settings.provider === "openai-codex") setHasCredentials(false);
      }),
    pending,
    run,
    selectConversation: setConversationId,
    send,
    newChat: () =>
      run(async () => {
        if (!runtime) return;
        const chat = await runtime.engine.newConversation();
        setConversationId(Number(chat.id));
        await refresh(runtime.engine);
      }),
    stop: () =>
      run(async () => {
        if (runtime && conversationId)
          await runtime.engine.stopConversation(conversationId);
      }),
    checkpoint: () =>
      run(async () => {
        if (runtime && conversationId) {
          await runtime.engine.checkpoint(
            conversationId,
            `Checkpoint ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`,
          );
          await refresh(runtime.engine);
        }
      }),
    restore: (id: string) =>
      run(async () => {
        if (runtime) {
          const branch = await runtime.engine.restoreCheckpoint(id);
          setConversationId(Number(branch.id));
          await refresh(runtime.engine);
        }
      }),
    install: (url: string) =>
      run(async () => {
        if (!runtime) return;
        await runtime.engine.installSkill(
          await loadSkill(url, nativeFetch as typeof fetch),
        );
        await refresh(runtime.engine);
      }),
    toggleSkill: (id: string) =>
      run(async () => {
        if (!runtime || !conversationId) return;
        setSelected(await runtime.engine.toggleSkill(conversationId, id));
      }),
    removeSkill: (id: string) =>
      run(async () => {
        if (!runtime || !conversationId) return;
        await runtime.engine.uninstallSkill(id);
        setSelected(
          await runtime.engine.read<string[]>(`skills:${conversationId}`, []),
        );
        await refresh(runtime.engine);
      }),
    repeat: (prompt: string, minutes: number, count: number) =>
      run(async () => {
        if (!runtime || !conversationId) return;
        if (!hasCredentials)
          throw new Error("Configure a model connection in Settings first.");
        await runtime.engine.prepareConversation(conversationId, settings);
        await runtime.engine.repeat(
          conversationId,
          prompt,
          minutes * 60000,
          count,
        );
        await refresh(runtime.engine);
      }),
    stopTask: (id: number) =>
      run(async () => {
        if (runtime) {
          await runtime.engine.stopTask(id);
          await refresh(runtime.engine);
        }
      }),
    saveSettings: (next: ModelSettings, key: string) =>
      run(async () => {
        if (!runtime) return;
        if (!runtime.models.getModel(next.provider, next.modelId))
          throw new Error("Choose a model from the current Pi model list.");
        if (key.trim() && next.provider !== "openai-codex")
          await credentials.set(next.provider, key);
        const ready = await credentials.has(next.provider);
        if (next.provider === "openai-codex" && !ready)
          throw new Error("Complete ChatGPT device code sign-in first.");
        if (conversationId)
          await runtime.engine.prepareConversation(conversationId, next);
        await runtime.engine.write("settings", next);
        runtime.engine.updateSettings(next);
        setSettings(next);
        setHasCredentials(ready);
        if (ready) await runtime.engine.resume();
      }),
    removeKey: () =>
      run(async () => {
        await credentials.remove(settings.provider);
        setHasCredentials(false);
      }),
  };
}
export type Moose = ReturnType<typeof useMoose>;
