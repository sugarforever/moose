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
import { codexAuth } from "./codex";
import { createIshWorkspaceFactory } from "./ish";

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
  const engine = await MobileEngine.open(
    new SerialSqliteDatabase(native),
    models,
    defaultSettings,
    Date.now,
    process.env.EXPO_PUBLIC_MOOSE_ISH === "1"
      ? createIshWorkspaceFactory()
      : (workspaceId) => createExpoWorkspace({ workspaceId }),
  );
  const settings = await engine.read<ModelSettings>(
    "settings",
    defaultSettings,
  );
  engine.updateSettings(settings);
  return { engine, models, settings };
}
