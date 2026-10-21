import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";
import * as FileSystem from "expo-file-system/legacy";
import {
  UpdateController,
  UpdateRateLimit,
  type AndroidUpdate,
} from "../updates/controller";

interface NativeUpdates {
  version: string;
  versionCode: number;
  verify(sha256: string, size: number, versionCode: number): Promise<void>;
  beginInstall(): number;
  cancelInstall(): void;
  install(
    sha256: string,
    size: number,
    versionCode: number,
    token: number,
  ): Promise<void>;
  canInstall(): Promise<boolean>;
  openPermission(token: number): Promise<void>;
}

export function createAndroidUpdates(): UpdateController | undefined {
  if (Platform.OS !== "android") return;
  const native = requireOptionalNativeModule<NativeUpdates>("MooseUpdates");
  // Older development clients can still open settings before being rebuilt.
  if (!native || !FileSystem.cacheDirectory || !FileSystem.documentDirectory)
    return;
  const directory = FileSystem.cacheDirectory + "moose-updates/";
  const apk = directory + "update.apk";
  const throttle = FileSystem.documentDirectory + "moose-update-check.json";
  const args = (update: AndroidUpdate) =>
    [update.sha256, update.size, update.versionCode] as const;
  return new UpdateController({
    version: native.version,
    versionCode: native.versionCode,
    now: Date.now,
    readCheckState: async () => {
      try {
        const value: unknown = JSON.parse(
          await FileSystem.readAsStringAsync(throttle),
        );
        const state = value as {
          nextCheck?: unknown;
          retryAt?: unknown;
        } | null;
        return {
          nextCheck:
            typeof state?.nextCheck === "number" &&
            Number.isFinite(state.nextCheck)
              ? state.nextCheck
              : 0,
          retryAt:
            typeof state?.retryAt === "number" && Number.isFinite(state.retryAt)
              ? state.retryAt
              : 0,
        };
      } catch {
        return { nextCheck: 0, retryAt: 0 };
      }
    },
    writeCheckState: (state) =>
      FileSystem.writeAsStringAsync(throttle, JSON.stringify(state)),
    json: async (url, signal) => {
      const abort = new AbortController();
      const onAbort = () => abort.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => abort.abort(), 20_000);
      try {
        signal.throwIfAborted();
        const response = await fetch(url, {
          signal: abort.signal,
          headers: { Accept: "application/json" },
        });
        if (response.status === 403 || response.status === 429) {
          const retry = Number(response.headers.get("retry-after"));
          const reset =
            Number(response.headers.get("x-ratelimit-reset")) * 1000;
          throw new UpdateRateLimit(
            Math.max(
              Date.now() + (retry > 0 ? retry : 3600) * 1000,
              reset || 0,
            ),
          );
        }
        if (!response.ok)
          throw new Error(`检查更新失败（HTTP ${response.status}）`);
        const text = await response.text();
        if (text.length > 2 * 1024 * 1024) throw new Error("更新信息过大");
        return JSON.parse(text) as unknown;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      }
    },
    download: async (update, signal, progress) => {
      await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
      await FileSystem.deleteAsync(apk, { idempotent: true });
      signal.throwIfAborted();
      const task = FileSystem.createDownloadResumable(
        update.url,
        apk,
        {},
        (event) => {
          progress(event.totalBytesWritten / update.size);
        },
      );
      const onAbort = () => {
        void task.cancelAsync().catch(() => {});
      };
      signal.addEventListener("abort", onAbort, { once: true });
      // Timeout also works when the server stops sending progress callbacks.
      const timer = setTimeout(onAbort, 15 * 60 * 1000);
      try {
        const result = await task.downloadAsync();
        signal.throwIfAborted();
        if (!result || result.status !== 200)
          throw new Error("下载未完成，请重试");
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      }
    },
    verify: (update) => native.verify(...args(update)),
    install: (update) => native.install(...args(update), native.beginInstall()),
    cancelInstall: () => native.cancelInstall(),
    canInstall: () => native.canInstall(),
    openPermission: () => native.openPermission(native.beginInstall()),
    removeDownload: () => FileSystem.deleteAsync(apk, { idempotent: true }),
  });
}
