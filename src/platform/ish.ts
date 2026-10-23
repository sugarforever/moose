import { NativeEventEmitter, NativeModules, Platform } from "react-native";
import { createIshWorkspace } from "../generated/runtime";
import type { IshBridge, IshOutput } from "../runtime/ish";
import type { MobileWorkspaceFactory } from "../runtime/files";

/** Explicit opt-in: a missing native build is an error, never a shell substitute. */
export function createIshWorkspaceFactory(prefix = ""): MobileWorkspaceFactory {
  if (Platform.OS !== "ios")
    throw new Error("The iSH environment requires iOS");
  const native = NativeModules.MooseISH;
  if (!native)
    throw new Error(
      "iSH native module is missing. Run prepare:ish and rebuild the iOS development client.",
    );
  const emitter = new NativeEventEmitter(native);
  const bridge: IshBridge = {
    prepare: (id) => native.prepare(id),
    execute: (...args) => native.execute(...args),
    cancel: (id) => native.cancel(id),
    cleanup: (id) => native.cleanup(id),
    subscribe(listener) {
      const subscription = emitter.addListener(
        "MooseISHOutput",
        (event: Object) => {
          const value = event as Partial<IshOutput>;
          if (
            typeof value.commandId === "string" &&
            typeof value.data === "string" &&
            (value.stream === "stdout" || value.stream === "stderr")
          )
            listener(value as IshOutput);
        },
      );
      return () => subscription.remove();
    },
  };
  return Object.assign(
    (id: string) => createIshWorkspace(prefix + id, bridge),
    { shell: true },
  );
}
