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
    if (!key.trim()) throw new Error("请输入 API Key");
    await SecureStore.setItemAsync(keyName(provider), key.trim(), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
  remove: (provider: string) => SecureStore.deleteItemAsync(keyName(provider)),
};
export async function openMobile() {
  const native = await openDatabaseAsync("moose.sqlite");
  await native.execAsync(
    "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;",
  );
  const models = createMobileModels(
    credentials.get,
    nativeFetch as typeof fetch,
    (signal) => codexAuth.getAccessToken(signal),
  );
  const database = new SerialSqliteDatabase(native);
  const permissions = await PermissionStore.open(database, async (request) => {
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
    return (
      (!request.skillId || !!skill) &&
      approvals.request(
        request,
        skill?.name ?? "Moose · 当前对话",
        title
          ? (JSON.parse(title.value) as string)
          : `对话 ${request.conversationId}`,
      )
    );
  });
  const engine = await MobileEngine.open(
    database,
    models,
    defaultSettings,
    Date.now,
    (workspaceId) => createExpoWorkspace({ workspaceId }),
    {
      openDatabase: openCapabilityDatabase,
      fetcher: nativeFetch as typeof fetch,
      authorize: (...args) => permissions.authorize(...args),
    },
  );
  const settings = await engine.read<ModelSettings>(
    "settings",
    defaultSettings,
  );
  engine.updateSettings(settings);
  return { engine, models, settings, permissions };
}
