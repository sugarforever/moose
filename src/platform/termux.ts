import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { getRandomBytes, randomUUID } from "expo-crypto";
import { fetch as nativeFetch } from "expo/fetch";
import { ed25519 } from "@noble/curves/ed25519.js";
import { TermuxEnvironment, signedTransport } from "../termux/environment";
import { hex, unhex } from "../termux/wire";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
const SEED = "moose.termux.signing-seed";
const ENABLED = "moose.termux.enabled";
const URL = "http://127.0.0.1:18765/";
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
export const termux = {
  status: () =>
    exclusive(async () => ({
      enabled:
        Platform.OS === "android" &&
        (await SecureStore.getItemAsync(ENABLED)) === "yes",
      publicKey: hex(ed25519.getPublicKey(await readSeed())),
    })),
  enable: (enabled: boolean) =>
    exclusive(async () => {
      if (Platform.OS !== "android") throw new Error("Termux 仅支持 Android");
      if (enabled) {
        const env = new TermuxEnvironment(
          "connection-check",
          signedTransport(
            URL,
            await readSeed(),
            nativeFetch as typeof fetch,
            randomUUID,
          ),
        );
        const result = await env.connect(BACKGROUND_CONTEXT);
        if (!result.ok) throw result.error;
        await env.cleanup(BACKGROUND_CONTEXT);
      }
      await SecureStore.setItemAsync(ENABLED, enabled ? "yes" : "no");
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
      );
      return (workspaceId: string) =>
        new TermuxEnvironment(`m-${namespace}-${workspaceId}`, rpc);
    }),
};
