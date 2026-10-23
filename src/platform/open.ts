import { Platform } from "react-native";
import { createIshWorkspaceFactory } from "./ish";
import { readyExecution } from "../termux/recovery";
import { acquireBackground, setApprovalWaiting } from "./background";
import { createExpoWorkspace } from "pi-durable-expo-env";
import { openDatabaseAsync } from "expo-sqlite";
import * as SecureStore from "expo-secure-store";
import { fetch as nativeFetch } from "expo/fetch";
import {
  MobileEngine,
  SerialSqliteDatabase,
  createMobileModels,
} from "../generated/runtime";
import type { ModelSettings } from "../runtime/engine";
import { termux } from "./termux";
import { PermissionStore } from "../generated/runtime";
import { approvals, openCapabilityDatabase } from "./capabilities";
import type { Skill } from "../skills/skills";
import { codexAuth } from "./codex";

export const defaultSettings: ModelSettings = {
  provider: "openai",
  modelId: "gpt-4.1-mini",
};
const keyName = (provider: string) => `moose.key.${provider}`;
export const credentials = {
  get: (provider: string) => SecureStore.getItemAsync(keyName(provider)),
  has: async (provider: string) =>
    provider === "openai-codex"
      ? (await codexAuth.status()).connected
      : !!(await SecureStore.getItemAsync(keyName(provider))),
  set: async (provider: string, key: string) => {
    if (!key.trim()) throw new Error("Enter an API key");
    await SecureStore.setItemAsync(keyName(provider), key.trim(), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
  remove: (provider: string) => SecureStore.deleteItemAsync(keyName(provider)),
};
export async function openMobile() {
  const native = await openDatabaseAsync("moose.sqlite");
  let nativeClosed = false;
  const closeNative = async () => {
    if (!nativeClosed) {
      await native.closeAsync();
      nativeClosed = true;
    }
  };
  const database = new SerialSqliteDatabase({
    execAsync: native.execAsync.bind(native),
    runAsync: native.runAsync.bind(native),
    getFirstAsync: native.getFirstAsync.bind(native),
    getAllAsync: native.getAllAsync.bind(native),
    closeAsync: closeNative,
  });
  let engine: MobileEngine | undefined;
  try {
    await native.execAsync(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;",
    );
    const models = createMobileModels(
      credentials.get,
      nativeFetch as typeof fetch,
      (signal) => codexAuth.getAccessToken(signal),
    );
    const ishFactory =
      Platform.OS === "ios" && process.env.EXPO_PUBLIC_MOOSE_ISH === "1"
        ? createIshWorkspaceFactory()
        : undefined;
    const termuxFactory = await termux.factory();
    const permissions = await PermissionStore.open(
      database,
      async (request) => {
        const row = await database.get<{ value: string }>(
          "SELECT value FROM moose_data WHERE key='skills'",
        );
        const skill = (row ? (JSON.parse(row.value) as Skill[]) : []).find(
          (s) => s.id === request.skillId,
        );
        const title = await database.get<{ value: string }>(
          "SELECT value FROM moose_data WHERE key=?",
          `title:${request.conversationId}`,
        );
        const waitKey = `permission-wait:${request.conversationId}`;
        await database.run(
          "INSERT OR REPLACE INTO moose_data(key,value) VALUES (?,?)",
          waitKey,
          JSON.stringify({
            skillId: request.skillId,
            permission: request.permission,
          }),
        );
        setApprovalWaiting(request.conversationId, true);
        try {
          return await ((!request.skillId || !!skill) &&
            approvals.request(
              request,
              skill?.name ?? "Moose · Current conversation",
              title
                ? (JSON.parse(title.value) as string)
                : `Conversation ${request.conversationId}`,
            ));
        } finally {
          await database.run("DELETE FROM moose_data WHERE key=?", waitKey);
          setApprovalWaiting(request.conversationId, false);
        }
      },
    );
    engine = await MobileEngine.open(
      database,
      models,
      defaultSettings,
      Date.now,
      ishFactory ??
        termuxFactory ??
        ((workspaceId) => createExpoWorkspace({ workspaceId })),
      {
        openDatabase: openCapabilityDatabase,
        fetcher: nativeFetch as typeof fetch,
        authorize: (...args) => permissions.authorize(...args),
      },
      { shell: !!termuxFactory },
      readyExecution(acquireBackground, termux.ensureReady),
    );
    const settings = await engine.read<ModelSettings>(
      "settings",
      defaultSettings,
    );
    engine.updateSettings(settings);
    return {
      engine,
      models,
      settings,
      permissions,
      executionEnvironment: ishFactory
        ? "ish"
        : termuxFactory
          ? "termux"
          : "local",
    };
  } catch (error) {
    try {
      if (engine) await engine.close();
      else await database.close().catch(() => {});
      await closeNative();
    } catch (cleanup) {
      try {
        await closeNative();
      } catch {}
      throw new AggregateError(
        [error, cleanup],
        "Initialization and runtime cleanup failed. Reopen the app.",
      );
    }
    throw error;
  }
}
