import * as Crypto from "expo-crypto";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";
import { codexAuth } from "./codex";
import { startLoopback, type TcpFactory } from "../auth/loopback";
import { CodexAuthError } from "../generated/runtime";

const encode = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
async function dismiss() {
  if (Platform.OS === "ios") {
    try {
      await WebBrowser.dismissBrowser();
    } catch {
      /* Already dismissed. */
    }
  }
}
export async function loginCodexBrowser(
  signal: AbortSignal,
  onWaiting: () => void,
) {
  const verifier = encode(Crypto.getRandomBytes(32));
  const state = encode(Crypto.getRandomBytes(32));
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    verifier,
  );
  const challenge = encode(
    new Uint8Array(digest.match(/.{2}/g)!.map((byte) => parseInt(byte, 16))),
  );
  const attempt = codexAuth.beginBrowser(
    { verifier, state, challenge },
    signal,
  );
  let tcp: TcpFactory;
  try {
    tcp = (await import("react-native-tcp-socket"))
      .default as unknown as TcpFactory;
  } catch {
    throw new CodexAuthError(
      "unavailable",
      "浏览器回调需要新版原生客户端，请重新编译或使用设备码登录",
    );
  }
  const listener = await startLoopback(tcp, { state, signal });
  const onAbort = () => {
    void dismiss();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) throw new CodexAuthError("cancelled", "登录已取消");
    onWaiting();
    // Android returns `opened` immediately: that is not cancellation.
    const browser = WebBrowser.openBrowserAsync(attempt.authorizationUrl).then(
      async (result) => {
        if (result.type === "cancel" || result.type === "dismiss") {
          // Allow a redirect arriving at the same moment as iOS sheet dismissal.
          return Promise.race([
            listener.result,
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new CodexAuthError("cancelled", "登录已取消")),
                500,
              ),
            ),
          ]);
        }
        return new Promise<never>(() => {});
      },
    );
    const callback = await Promise.race([listener.result, browser]);
    await dismiss();
    return await codexAuth.completeBrowser(attempt, callback, signal);
  } finally {
    signal.removeEventListener("abort", onAbort);
    await listener.close();
    await dismiss();
  }
}
