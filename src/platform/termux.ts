import { Platform, PermissionsAndroid, type Permission } from "react-native";
import { requireOptionalNativeModule } from "expo";
import * as SecureStore from "expo-secure-store";
import { getRandomBytes, randomUUID } from "expo-crypto";
import { fetch as nativeFetch } from "expo/fetch";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  TermuxEnvironment,
  signedTransport,
  TermuxTransportError,
} from "../termux/environment";
import {
  TermuxSetup,
  type NativeSetupStatus,
  type SetupPhase,
  type ProbeResult,
} from "../termux/setup";
import { termuxDiagnostics } from "../termux/diagnostics";
import { runTermuxSelfTest, type SelfTestPhase } from "../termux/self-test";
import { hex, unhex } from "../termux/wire";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
const SEED = "moose.termux.signing-seed";
const ENABLED = "moose.termux.enabled";
const URL = "http://127.0.0.1:18765/";
const PERMISSION = "com.termux.permission.RUN_COMMAND" as Permission;
type Bridge = {
  status(): Promise<NativeSetupStatus>;
  start(publicKey: string): Promise<{ assetHash: string }>;
  stopBootstrap(): Promise<void>;
  openSettings(): Promise<void>;
  openTermux(): Promise<void>;
};
function native(): Bridge {
  if (Platform.OS !== "android") throw new Error("Termux 仅支持 Android");
  const bridge = requireOptionalNativeModule<Bridge>("MooseTermux");
  if (!bridge) throw new Error("请安装包含 Termux 自动配置模块的新版 APK");
  return bridge;
}
let serial: Promise<unknown> = Promise.resolve();
const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = serial.then(operation);
  serial = result.catch(() => {});
  return result;
};
async function readSeed() {
  const saved = await SecureStore.getItemAsync(SEED);
  if (saved) return unhex(saved);
  const seed = getRandomBytes(32);
  await SecureStore.setItemAsync(SEED, hex(seed), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return seed;
}
export const termuxSetupCommand =
  "mkdir -p ~/.termux && printf '\\nallow-external-apps = true\\n' >> ~/.termux/termux.properties && termux-reload-settings";
export const termux = {
  status: () =>
    exclusive(async () => ({
      enabled:
        Platform.OS === "android" &&
        (await SecureStore.getItemAsync(ENABLED)) === "yes",
      ...(await native().status()),
    })),
  requestPermission: async () => {
    native();
    const granted = await PermissionsAndroid.request(PERMISSION);
    if (granted !== PermissionsAndroid.RESULTS.GRANTED)
      throw new Error("请在 Moose 的系统应用权限中允许在 Termux 中运行命令");
  },
  openSettings: () => native().openSettings(),
  openTermux: () => native().openTermux(),
  select: (enabled: boolean) =>
    exclusive(async () => {
      if (Platform.OS !== "android") throw new Error("Termux 仅支持 Android");
      await SecureStore.setItemAsync(ENABLED, enabled ? "yes" : "no");
    }),
  enable: (
    enabled: boolean,
    signal: AbortSignal,
    onPhase: (phase: SetupPhase) => void,
  ) =>
    exclusive(async () => {
      if (Platform.OS !== "android") throw new Error("Termux 仅支持 Android");
      const previous = await SecureStore.getItemAsync(ENABLED);
      if (enabled) {
        const seed = await readSeed();
        const rpc = signedTransport(
          URL,
          seed,
          nativeFetch as typeof fetch,
          randomUUID,
          termuxDiagnostics.record,
        );
        const probe = async (
          probeSignal: AbortSignal,
        ): Promise<ProbeResult> => {
          const context = withAbortSignal(probeSignal, BACKGROUND_CONTEXT);
          try {
            const info = await rpc(
              "connection-check",
              "/workspace",
              "serviceInfo",
              [],
              context,
            );
            if (!info.ok || info.value.protocol !== 1 || !info.value.buildHash)
              return { kind: "incompatible", message: "服务版本无法识别" };
            const env = new TermuxEnvironment("connection-check", rpc);
            const connected = await env.connect(context);
            if (!connected.ok) throw connected.error;
            await env.cleanup(context);
            return { kind: "ready", hash: info.value.buildHash };
          } catch (error) {
            if (probeSignal.aborted) throw error;
            const message =
              error instanceof Error ? error.message : String(error);
            if (
              (error instanceof TermuxTransportError &&
                ["rejected", "protocol", "service"].includes(error.kind)) ||
              /rejected|Unsupported operation|Unexpected token|JSON/.test(
                message,
              )
            )
              return { kind: "incompatible", message };
            return { kind: "offline" };
          }
        };
        const setup = new TermuxSetup({ native: native(), probe });
        const started = Date.now();
        await setup.run(hex(ed25519.getPublicKey(seed)), signal, (phase) => {
          termuxDiagnostics.record({
            op: `setup.${phase}`,
            result: "stage",
            elapsedMs: Date.now() - started,
          });
          onPhase(phase);
        });
      }
      signal.throwIfAborted();
      await SecureStore.setItemAsync(ENABLED, enabled ? "yes" : "no");
      if (signal.aborted) {
        await SecureStore.setItemAsync(ENABLED, previous ?? "no");
        signal.throwIfAborted();
      }
    }),
  selfTest: (signal: AbortSignal, onPhase: (phase: SelfTestPhase) => void) =>
    exclusive(async () => {
      native();
      const seed = await readSeed();
      const rpc = signedTransport(
        URL,
        seed,
        nativeFetch as typeof fetch,
        randomUUID,
        termuxDiagnostics.record,
      );
      await runTermuxSelfTest(
        rpc,
        randomUUID(),
        withAbortSignal(signal, BACKGROUND_CONTEXT),
        onPhase,
      );
    }),
  factory: () =>
    exclusive(async () => {
      if (
        Platform.OS !== "android" ||
        (await SecureStore.getItemAsync(ENABLED)) !== "yes"
      )
        return undefined;
      const seed = await readSeed();
      const namespace = hex(ed25519.getPublicKey(seed)).slice(0, 16);
      const rpc = signedTransport(
        URL,
        seed,
        nativeFetch as typeof fetch,
        randomUUID,
        termuxDiagnostics.record,
      );
      return (workspaceId: string) =>
        new TermuxEnvironment(`m-${namespace}-${workspaceId}`, rpc);
    }),
};
