# Termux foreground recovery

## Design and acceptance

The Termux adapter uses signed per-request HTTP, not a persistent connection. The app previously did not check the companion after returning to the foreground or before admitting a response. A selected but stopped service therefore left chat tools failing until manual setup was run. This explains the missing recovery path; it does not establish why a particular phone lost service.

Check the selected service on foreground return and before admitting each engine run (including repeating iterations). Reuse the existing signed identity probe and fixed native bootstrap with a 30-second automatic deadline. Serialize checks with manual setup and preference changes. Local-file selection never launches Termux. Foreground checks abort when the Activity leaves or its view detaches. Admission failure releases the background lease and prevents the response from starting.

Keep the existing application Hermes/Harness owner. Recovery never resumes/reopens it, resubmits a chat request, replays a shell command, deletes receipts, or acknowledges unknown outcomes. The bootstrap must retain its existing fail-closed interrupted-command handling. Incompatible services and missing permissions remain errors requiring user action. Manual setup remains available for initial installation and repairs exceeding the automatic deadline.

Acceptance: healthy foreground/background return; deliberate companion loss followed by return; same-runtime signed file/bash operations after recovery; cancelled and queued recovery; disabled environment; incompatible service and unknown command outcome refusal. Record controlled transport tests separately from Android Termux and physical-device evidence below.

## Validation on 2026-10-22

- `npm ci` installed the lockfile in the isolated worktree. `npm run verify` passed: 188 tests, 8 intentionally skipped watcher cases, 3 real bootstrap tests, TypeScript, portable smoke, and iOS/Android Hermes resource exports. `npm run smoke:termux` passed signed HTTP/file/shell/cleanup and interrupted-receipt recovery checks without model requests.
- Android debug APK compiled with Java 17 / Android SDK 35, installed, and operated on the Android 15/API 35 arm64 emulator. Native Termux was the official GitHub `v0.118.3` arm64 debug APK, with Termux Node `v24.18.0`, util-linux and its updated C++ runtime. No physical phone was operated and no real provider/account request was made.
- The opt-in probe exercised actual Pi `write` and `bash` tools over signed loopback HTTP to Node in Termux, with controlled OpenAI SSE. It verified the real shell result and the file on Termux's filesystem. Initial run passed; Home → Moose → second run passed with the same companion process. Ordinary switching did **not** reproduce the reported physical-device failure.
- Deliberately SIGKILLing only the idle Moose companion Node process made the signed self-test fail with transport-unavailable and no Node listener present. Home → Moose automatically launched a new companion before another response was requested. The next real tool run passed. Killing the companion again while Moose remained visible, then submitting another controlled response, also repaired service before tool execution. No manual reconnect was used for either recovery.
- Across those four responses, Moose PID remained `6019`, controlled request count progressed `3 → 6 → 9 → 12`, and the probe retained the same cached `MobileEngine`/Harness. Companion PID progressed `5951 → 6346 → 6479`. Activity return used the existing native Activity, without development reloads. Thus the test establishes service-loss recovery, not an Android/OEM explanation for the original loss.
- Controlled platform regressions cover healthy reuse, disabled selection, incompatible service refusal, interrupted-command bootstrap error propagation, cancellation before queued work starts, and the 30-second deadline including queue wait. Admission tests cover caller/native-stop cancellation and lease release. Existing real service/journal tests establish unknown-command replay protection; the interrupted-command refusal case was not induced on Android.
- Expo Doctor passed 18/20 checks. Existing TCP New Architecture / local-module metadata warnings remain. The current SDK recommendation also flags the pinned Expo `58.0.16`, sharing `58.0.19`, and status-bar `58.0.3` as one patch behind. Dependencies were not changed for this repair. APK compilation, emulator operation, and resource exports are separate evidence; no release APK, IPA, physical-device validation, or real account/model inference was performed.

## Repeating the emulator probe

Build/install an Android development client, initialize Termux and its command permission/configuration as in the setup guide, then run:

```sh
EXPO_PUBLIC_MOOSE_TERMUX_RECOVERY_SMOKE=1 npx expo start --dev-client
```

The probe uses `termux-recovery-smoke.sqlite`, fake model credentials and controlled SSE, and creates real conversation workspaces inside Termux. Tap **Connect Termux**, then **Run controlled tools**. Switch to Home and return through the Activity; run tools again. Identify and stop only the idle Moose companion Node process in the emulator, then tap **Check without repair** to establish the offline failure. Switch away and back, and run tools again without tapping Connect. Repeat service loss while remaining visible and run tools directly to check admission repair. Never kill arbitrary Termux processes or interrupt a real command merely to test recovery. Unknown external effects require owner inspection; this probe never acknowledges receipts.
