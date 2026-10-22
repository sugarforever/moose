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
  if (Platform.OS !== "android")
    throw new Error("Termux is only supported on Android");
  const bridge = requireOptionalNativeModule<Bridge>("MooseTermux");
  if (!bridge)
    throw new Error(
      "Install a newer APK that includes the Termux setup module",
    );
  return bridge;
}
let serial: Promise<unknown> = Promise.resolve();
const exclusive = <T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  const result = serial.then(() => {
    signal?.throwIfAborted();
    return operation();
  });
  serial = result.catch(() => {});
  if (!signal) return result;
  // Cancelling a waiter must not unlock a still-running predecessor.
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(signal.reason ?? new Error("Termux recovery cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void result
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
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
async function checkOrRepair(
  signal: AbortSignal,
  onPhase: (phase: SetupPhase) => void,
  timeoutMs?: number,
) {
  signal.throwIfAborted();
  const seed = await readSeed();
  const rpc = signedTransport(
    URL,
    seed,
    nativeFetch as typeof fetch,
    randomUUID,
    termuxDiagnostics.record,
  );
  const probe = async (probeSignal: AbortSignal): Promise<ProbeResult> => {
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
        return {
          kind: "incompatible",
          message: "Unrecognized service version",
        };
      const env = new TermuxEnvironment("connection-check", rpc);
      const connected = await env.connect(context);
      if (!connected.ok) throw connected.error;
      await env.cleanup(context);
      return { kind: "ready", hash: info.value.buildHash };
    } catch (error) {
      if (probeSignal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (
        (error instanceof TermuxTransportError &&
          ["rejected", "protocol", "service"].includes(error.kind)) ||
        /rejected|Unsupported operation|Unexpected token|JSON/.test(message)
      )
        return { kind: "incompatible", message };
      return { kind: "offline" };
    }
  };
  const setup = new TermuxSetup({ native: native(), probe, timeoutMs });
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
      throw new Error(
        "Allow Moose to run commands in Termux in system app permissions",
      );
  },
  openSettings: () => native().openSettings(),
  openTermux: () => native().openTermux(),
  select: (enabled: boolean) =>
    exclusive(async () => {
      if (Platform.OS !== "android")
        throw new Error("Termux is only supported on Android");
      await SecureStore.setItemAsync(ENABLED, enabled ? "yes" : "no");
    }),
  enable: (
    enabled: boolean,
    signal: AbortSignal,
    onPhase: (phase: SetupPhase) => void,
  ) =>
    exclusive(async () => {
      if (Platform.OS !== "android")
        throw new Error("Termux is only supported on Android");
      const previous = await SecureStore.getItemAsync(ENABLED);
      if (enabled) {
        await checkOrRepair(signal, onPhase);
      }
      signal.throwIfAborted();
      await SecureStore.setItemAsync(ENABLED, enabled ? "yes" : "no");
      if (signal.aborted) {
        await SecureStore.setItemAsync(ENABLED, previous ?? "no");
        signal.throwIfAborted();
      }
    }),
  // Uses the same queue as manual setup/selection, but never changes preferences.
  ensureReady: async (signal: AbortSignal) => {
    const operation = new AbortController();
    const abort = () => operation.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    // Include time waiting behind manual setup, not only time at the queue head.
    const timer = setTimeout(
      () =>
        operation.abort(
          new Error(
            "Termux recovery timed out. Check or repair connection in Settings.",
          ),
        ),
      30_000,
    );
    try {
      await exclusive(async () => {
        if (
          Platform.OS !== "android" ||
          (await SecureStore.getItemAsync(ENABLED)) !== "yes"
        )
          return;
        await checkOrRepair(operation.signal, () => {}, 30_000);
      }, operation.signal);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  },
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
