# Codex Browser Callback Integration

References: the local rn-ai-kit repository, [issue #4](https://github.com/sugarforever/rn-ai-kit/issues/4), and [PR #5](https://github.com/sugarforever/rn-ai-kit/pull/5). Add browser OAuth + PKCE as an alternative to device-code login, sharing the same SecureStore, refresh flow, and Codex inference channel.

## Implementation and acceptance

1. The portable authentication layer generates authorization URLs, strictly validates callback origin/path/state/duplicate parameters, and exchanges the original verifier for tokens. Reuse serialized saving and cancellation rollback.
2. The platform layer temporarily binds 127.0.0.1:1455 through react-native-tcp-socket and opens the browser only after the listener is ready. Accept only bounded-size GET requests; an incorrect state must not consume the login attempt. Bound connection counts, request size, idle time, and total waiting time.
3. Use an in-app browser on iOS and a browser tab on Android. Android's browser call immediately returns opened; this must not be treated as user cancellation. Clean up the listener on completion, cancellation, timeout, and port conflicts. Continue waiting after returning to the app and provide explicit cancellation.
4. Write protocol and listener behavior tests before implementation. Run complete checks, an iOS native build, and local synthetic callback tests in the simulator. Real account authorization is completed by the user; synthetic callbacks do not establish account availability.
5. Do not depend on the local rn-ai-kit checkout or modify its workspace. Reference its approach and the public protocol while implementing a minimal adapter independently. Native dependencies require a development build; Expo Go is unsupported.
