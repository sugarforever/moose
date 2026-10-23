import { RuntimeOwner } from "../runtime/execution-owner";
import { openMobile, credentials } from "./open";
import {
  configureBackground,
  cancelInterruptedBackground,
  fenceRuntimeChange,
} from "./background";
import { termux } from "./termux";
import { replaceRuntime } from "../termux/switch";
import type { SetupPhase } from "../termux/setup";
type Runtime = Awaited<ReturnType<typeof openMobile>>;
function bind(runtime: Runtime) {
  configureBackground((cause) => runtime.engine.stopAll(cause), runtime.engine);
  return runtime;
}
const owner = new RuntimeOwner(async () => bind(await openMobile()));
export const getMobileRuntime = () => owner.get();
const recovery = new WeakMap<Runtime, Promise<void>>();
export function recoverMobileRuntime(runtime: Runtime) {
  let pending = recovery.get(runtime);
  if (!pending) {
    pending = (async () => {
      await cancelInterruptedBackground((cause) =>
        runtime.engine.stopAll(cause),
      );
      if (await credentials.has(runtime.settings.provider))
        await runtime.engine.resume();
    })();
    recovery.set(runtime, pending);
  }
  return pending;
}
export class RuntimeUnavailable extends Error {}
export async function changeMobileEnvironment(
  enabled: boolean,
  signal: AbortSignal,
  onPhase: (phase: SetupPhase) => void,
) {
  fenceRuntimeChange(true);
  let changed: { runtime: Runtime; error?: unknown } | undefined;
  let closed = false;
  try {
    await owner.replace(async (current) => {
      const previous = current.executionEnvironment === "termux";
      changed = await replaceRuntime({
        current,
        assertIdle: async () => {
          signal.throwIfAborted();
          await current.engine.assertEnvironmentSwitchIdle();
          signal.throwIfAborted();
        },
        select: () => termux.enable(enabled, signal, onPhase),
        close: async (old) => {
          closed = true;
          await old.engine.close();
        },
        open: async () => {
          signal.throwIfAborted();
          const next = await openMobile();
          if (signal.aborted) {
            await next.engine.close();
            signal.throwIfAborted();
          }
          return next;
        },
        restore: () => termux.select(previous),
        reopen: () => openMobile(),
      });
      return bind(changed.runtime);
    });
    return changed!;
  } catch (error) {
    if (closed) {
      owner.invalidate();
      throw new RuntimeUnavailable(
        "Runtime replacement failed. Reopen the runtime.",
        { cause: error },
      );
    }
    throw error;
  } finally {
    fenceRuntimeChange(false);
  }
}
