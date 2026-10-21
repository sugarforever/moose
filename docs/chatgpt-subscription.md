# ChatGPT Subscription Integration Research and Design

Research date: 2026-10-18. This document distinguishes actual open-source implementations, official guidance, and the scope of Moose validation.

## Findings

| Source                                                                                                        | Authentication and inference implementation                                                                                   | Mobile implications                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Pi Codex OAuth](https://github.com/earendil-works/pi/blob/main/packages/ai/src/auth/oauth/openai-codex.ts)   | Browser callback and device-code login; device-code HTTPS polling for tokens, with refresh support                            | The device-code protocol can be ported independently, avoiding the Node HTTP callback server in the same file                                                  |
| [Official Codex](https://github.com/openai/codex/blob/main/codex-rs/login/src/device_code_auth.rs)            | Requests a device code, polls authorization, and exchanges a server-provided verifier for tokens; 15-minute timeout           | Confirms that this flow needs no local port; it is not web cookie or session scraping                                                                          |
| [OpenCode](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/plugin/provider/openai.ts)        | Codex device code (legacy), the same device authorization endpoints and public client ID, and a separate Codex backend        | Confirms other current open-source clients use this compatibility path; inspect actual source when directories change, rather than relying on search summaries |
| [Microsoft Amplifier ChatGPT Provider](https://github.com/microsoft/amplifier-module-provider-openai-chatgpt) | Device-code login, automatic refresh, and separate Codex SSE inference                                                        | The subscription protocol differs from the ordinary OpenAI API and should retain a separate provider                                                           |
| [Official Codex authentication documentation](https://learn.chatgpt.com/docs/auth)                            | Recommends device code (beta) where callbacks are unreachable; the account or workspace must enable device-code authorization | Users sign in through the system browser and enter the device code they requested; the app need not listen on localhost                                        |

The user's name “PyAgent” did not identify a unique subscription integration repository under that exact spelling. This project continues with the confirmed Pi / Pi Agent stack; the Pi implementation above was the one verified.

Earlier consideration of only the [new public client registration flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) led to an overly narrow inference from its HTTP loopback requirement that all subscription logins need native listeners. Codex device code is another existing path. Client IDs, token purposes, and backends from these flows must not be mixed.

## Moose implementation plan

- An independent portable device-code client using only fetch, timers, and AbortController. Its public client ID matches the Pi / Codex compatible implementation; it contains no client secret.
- Request a device code, show the verification code and fixed official verification URL, and poll at the server's interval. Handle authorization denial, cancellation, expiration, and slow_down.
- Store sensitive tokens only in SecureStore; keep device codes only in memory for the current login. Error messages include necessary status without echoing sensitive server responses.
- Serialize token refresh and local credential changes, saving rotated refresh tokens to avoid concurrent refreshes and credential rewrites after sign-out.
- Register Pi's Codex model catalog and streaming implementation as `openai-codex`, forcing SSE through Expo fetch. Keep the API-key channel separate, with no automatic billed fallback.
- Successful authorization means only that credentials were saved. Use them for a conversation only after the user explicitly selects the subscription connection. A model catalog does not establish that the account can access every listed model.

The Codex backend offers no stable compatibility guarantee as an ordinary public API; this integration is experimental. Account eligibility, workspace policies, quotas, model availability, and server protocols may change. Users must first enable device-code authorization in their ChatGPT security settings or workspace policy.

## Validation boundaries

Automated tests use controlled HTTPS responses to cover the complete device-code protocol, refresh/sign-out races, and the target URL and authentication headers of the real Pi Codex streaming adapter. Report real account login and subscription inference as verified only after actually completing them.

Validation record for 2026-10-18:

- `npm run verify` passed: 23 tests, TypeScript, the simulated Pi Durable / SQLite / device authorization / Codex SSE path without Node globals, and Android/iOS Hermes exports.
- Independent code review found and fixed two storage timing issues. Regression tests were added for cancellation during delayed writes, preserving the previous account, and sign-out during refresh.
- The new settings page ran on the iPhone 17 Pro simulator, successfully requested a device code from the official service, displayed a countdown, and restored the initial login state after cancellation. Account authorization was not completed; no real tokens or inference requests were used.
- Android validation in this iteration covered bundling only; there is no device execution evidence.

## Local HTTP callback flow

After the user supplied the local rn-ai-kit checkout, [issue #4](https://github.com/sugarforever/rn-ai-kit/issues/4) and subsequent [PR #5](https://github.com/sugarforever/rn-ai-kit/pull/5) were checked. The original suggestion used [SwiftWebServer](https://github.com/atom2ueki/SwiftWebServer) for a temporary iOS listener. Current [CodingPlanKit](https://github.com/atom2ueki/CodingPlanKit) uses it for native authentication; rn-ai-kit added cross-platform injection through react-native-tcp-socket.

Moose adds a separate browser button: Expo Crypto generates random state and S256 PKCE, native TCP binds 127.0.0.1:1455, and the browser opens only after ready. Accept only /auth/callback, validating state, duplicate parameters, and authorization errors. Exchange the original verifier over HTTPS, reusing secure saving and refresh. Incorrect state does not end the listener. Bound request size, connection count, idle time, and total waiting time; clean up the port on success, failure, and cancellation.

The implementation lives in src/auth/loopback.ts and src/platform/codex-browser.ts and does not depend on another local repository. Compared with the reference implementation, it explicitly waits for listener readiness, validates callback state, and handles Android's immediate opened result and cancellation before native listener readiness. iOS uses Expo's in-app browser and dismisses it on completion. On Android, if the tab still shows the callback page, tap Return to Moose.

This flow requires a native build; Expo Go is unsupported. OS suspension or termination can still interrupt login; start it again. No persistent background permission or relaxed global network security policy was added for the listener.

Swift source details: `OAuth2PKCEFlow.beginLogin()` starts `LocalCallbackServer` and awaits `waitUntilStarted()` before constructing the localhost redirect URI. `OpenAIAuthProvider` supports callbackScheme; the local server bridges to a custom scheme, which `BrowserAuthSession`'s ASWebAuthenticationSession intercepts to dismiss the page. Moose uses rn-ai-kit's Expo browser approach, completing authorization directly through the TCP callback and explicitly dismissing on iOS; it does not copy Swift's second scheme forwarding step.

Validation for this iteration: 34 tests, type checking, portable runtime validation, and Android/iOS Hermes exports passed; iOS native Debug compilation, installation, and launch passed. The official login page opened successfully in the simulator. The Moose process bound only IPv4 127.0.0.1:1455; unrelated paths returned 404 and incorrect state returned 400. Closing the browser showed cancellation in the UI and released the port. Token exchange with correct callback state is covered by controlled protocol tests; real account login and subscription inference were not completed. Expo Doctor scored 19/20: react-native-tcp-socket's React Native Directory metadata marks the New Architecture as untested. This warning remains; Android native execution still needs validation.
