import type { Cancellation } from "../runtime/execution-diagnostics";
import {
  AppRegistry,
  AppState,
  PermissionsAndroid,
  Platform,
} from "react-native";
import { requireOptionalNativeModule, type EventSubscription } from "expo";
import {
  ExecutionOwner,
  type ExecutionLease,
} from "../runtime/execution-owner";

interface NativeBackground {
  start(token: string): Promise<void>;
  ready(token: string): void;
  stop(token: string): Promise<void>;
  waiting(value: boolean): void;
  pendingStop(): boolean;
  stopDetail?(): Cancellation | null;
  acknowledgeStop(): void;
  addListener(event: "stop", listener: () => void): EventSubscription;
}
let owner: ExecutionOwner | undefined;
let cancelCurrent: (cause?: Cancellation) => Promise<void>;
let changing = false;
export function fenceRuntimeChange(value: boolean) {
  if (value && changing)
    throw new Error("Execution environment is already changing");
  if (value && owner?.busy)
    throw new Error("Wait for all background runs to finish");
  changing = value;
}
let native: NativeBackground | null | undefined;
function module() {
  return (native ??=
    requireOptionalNativeModule<NativeBackground>("MooseBackground"));
}
export function configureBackground(
  cancel: (cause?: Cancellation) => Promise<void>,
) {
  cancelCurrent = cancel;
  if (Platform.OS !== "android" || owner) return;
  const bridge = module();
  owner = new ExecutionOwner(
    {
      start: async (token, signal) => {
        signal.throwIfAborted();
        if (!bridge)
          throw new Error(
            "Rebuild the Android client to enable background execution",
          );
        if (AppState.currentState !== "active")
          throw new Error("Return to Moose to start a task");
        if (Number(Platform.Version) >= 33) {
          const permission = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
          );
          if (permission !== PermissionsAndroid.RESULTS.GRANTED)
            throw new Error("Allow notifications to start background tasks");
        }
        signal.throwIfAborted();
        await bridge.start(token);
      },
      stop: async (token) => {
        await bridge?.stop(token);
      },
    },
    () =>
      cancelCurrent(
        bridge?.stopDetail?.() ?? {
          reason: "native_stop_unknown",
          at: Date.now(),
        },
      ),
  );
  bridge?.addListener("stop", () => {
    void owner!
      .cancel()
      .then(() => bridge.acknowledgeStop())
      .catch(() => {});
  });
}
export function setApprovalWaiting(value: boolean) {
  if (Platform.OS === "android") module()?.waiting(value);
}
export async function cancelInterruptedBackground(
  cancel: (cause?: Cancellation) => Promise<void>,
) {
  if (Platform.OS === "android" && module()?.pendingStop()) {
    await cancel(
      module()?.stopDetail?.() ?? {
        reason: "native_stop_unknown",
        at: Date.now(),
      },
    );
    module()!.acknowledgeStop();
  }
}
export async function acquireBackground(
  signal?: AbortSignal,
): Promise<ExecutionLease> {
  if (changing) throw new Error("Execution environment is changing");
  if (!owner)
    return { signal: new AbortController().signal, release: async () => {} };
  // A sleeping repeat never starts an FGS from background. Cancellation must also
  // interrupt this wait, so abortTask/close cannot hang behind a hidden Activity.
  if (!owner.active && AppState.currentState !== "active") {
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        subscription.remove();
        reject(new Error("Task cancelled"));
      };
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") {
          subscription.remove();
          signal?.removeEventListener("abort", abort);
          resolve();
        }
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  if (signal?.aborted) throw new Error("Task cancelled");
  if (changing) throw new Error("Execution environment is changing");
  return owner.acquire();
}
export function registerBackgroundTask() {
  if (Platform.OS !== "android") return;
  AppRegistry.registerHeadlessTask(
    "MooseExecution",
    () =>
      async ({ token }: { token: string }) => {
        if (!owner) throw new Error("Runtime owner missing");
        const finished = owner.attach(token);
        module()!.ready(token);
        await finished;
      },
  );
}
