import {
  ExecutionNotifications,
  notificationFailure,
} from "../runtime/execution-notifications";
import { executionStatus } from "../generated/runtime";
import type { MobileEngine } from "../runtime/engine";
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
  waiting(id: number, value: boolean): void;
  progress(items: { id: number; state: string; retries: number }[]): void;
  result(id: number, failed: boolean, detail: string): Promise<void>;
  pendingStop(): boolean;
  stopDetail?(): Cancellation | null;
  acknowledgeStop(): void;
  addListener(event: "stop", listener: () => void): EventSubscription;
}
let owner: ExecutionOwner | undefined;
let notifications: ExecutionNotifications | undefined;
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
  engine?: MobileEngine,
) {
  if (Platform.OS === "android" && engine) {
    const snapshot = (view: Awaited<ReturnType<MobileEngine["view"]>>) => ({
      revision: JSON.stringify([
        view.entries.at(-1),
        view.docs?.["moose.execution"],
        view.docs?.["moose.outcome"],
      ]),
      status: executionStatus(view),
    });
    notifications = new ExecutionNotifications({
      read: async (id) => snapshot(await engine.view(id)),
      watch: (id, listener) =>
        engine.watch(id, (view) => listener(snapshot(view))),
      progress: (items) =>
        module()?.progress(
          items.map(({ id, status }) => ({
            id,
            state: status.state,
            retries: status.retries,
          })),
        ),
      result: async (id, status) => {
        await module()?.result(
          id,
          status.state === "failed",
          notificationFailure(status.reason),
        );
      },
    });
  }
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
export function setApprovalWaiting(id: number, value: boolean) {
  if (Platform.OS === "android") module()?.waiting(id, value);
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
  ids: readonly number[] = [],
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
  const lease = await owner.acquire();
  let finish: (() => Promise<void>) | undefined;
  try {
    finish = await notifications?.track(ids);
  } catch {
    /* Notification observation must not prevent cancellation or execution. */
  }
  return {
    signal: lease.signal,
    release: async () => {
      try {
        await finish?.();
      } catch {
        /* The committed task result remains available in chat. */
      } finally {
        await lease.release();
      }
    },
  };
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
