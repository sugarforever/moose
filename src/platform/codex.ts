import * as SecureStore from "expo-secure-store";
import { fetch as nativeFetch } from "expo/fetch";
import { CodexAuth } from "../generated/runtime";

export const codexAuth = new CodexAuth(
  {
    get: (key) => SecureStore.getItemAsync(key),
    set: (key, value) =>
      SecureStore.setItemAsync(key, value, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      }),
    remove: (key) => SecureStore.deleteItemAsync(key),
  },
  nativeFetch as typeof fetch,
);
