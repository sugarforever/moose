import { AppState } from "react-native";
import { digestStringAsync, CryptoDigestAlgorithm } from "expo-crypto";
import { openDatabaseAsync } from "expo-sqlite";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { SerialSqliteDatabase } from "../generated/runtime";
import type { PermissionRequest } from "../capabilities/permissions";
import type { Artifact } from "../capabilities/service";

export type Approval = Omit<PermissionRequest, "signal"> & {
  skillName: string;
  title: string;
  resolve: (allow: boolean) => void;
};
let current: Approval | undefined;
const listeners = new Set<() => void>();
export const approvals = {
  get: () => current,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  request: (
    request: PermissionRequest,
    skillName: string,
    title: string,
  ): Promise<boolean> =>
    new Promise((resolve) => {
      if (AppState.currentState !== "active" || request.signal.aborted) {
        resolve(false);
        return;
      }
      let completed = false;
      const finish = (allow: boolean) => {
        if (completed) return;
        completed = true;
        request.signal.removeEventListener("abort", cancel);
        subscription.remove();
        current = undefined;
        for (const fn of listeners) fn();
        resolve(
          allow &&
            !request.signal.aborted &&
            AppState.currentState === "active",
        );
      };
      const cancel = () => finish(false);
      const subscription = AppState.addEventListener("change", (state) => {
        if (state !== "active") cancel();
      });
      request.signal.addEventListener("abort", cancel, { once: true });
      current = { ...request, skillName, title, resolve: finish };
      for (const fn of listeners) fn();
    }),
};
export const permissionLabel = (permission: string) =>
  permission.startsWith("http:")
    ? `Read ${permission.slice(5)}`
    : permission === "database:read"
      ? "Read the database in this scope"
      : permission === "database:write"
        ? "Modify the database in this scope"
        : "Read and modify documents across conversations";
export async function openCapabilityDatabase(key: string) {
  const digest = await digestStringAsync(CryptoDigestAlgorithm.SHA256, key);
  const native = await openDatabaseAsync(`moose-skill-${digest}.sqlite`);
  await native.execAsync(
    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;",
  );
  return new SerialSqliteDatabase(native);
}
export async function shareArtifact(artifact: Artifact) {
  if (!(await Sharing.isAvailableAsync()))
    throw new Error("File sharing is not supported on this device");
  const file = new File(
    Paths.cache,
    `moose-${artifact.ref.slice(9)}.${artifact.mime === "text/html" ? "html" : "txt"}`,
  );
  file.write(artifact.text);
  // The receiving app may read asynchronously after the sheet closes. Keep this bounded export in OS-managed cache.
  await Sharing.shareAsync(file.uri, {
    mimeType: artifact.mime,
    dialogTitle: artifact.title,
    UTI: artifact.mime === "text/html" ? "public.html" : "public.plain-text",
  });
}
