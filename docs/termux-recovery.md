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

## Physical Xiaomi observation on 2026-10-22

The user subsequently reported another chat timeout on the released v0.3.0. Wireless ADB connected to Xiaomi model `23127PN0CC` (`houji`); installed Moose version was `0.3.0`, versionCode `9`. The PR build was not installed on the phone.

Before repair, Termux PID `9420`, Moose PID `12332`, and companion Node PID `19690` were present. Loopback port `18765` was listening with receive queue `2`. An ADB-forwarded unauthenticated GET timed out twice after five seconds without HTTP headers. This GET cannot execute a tool; a responsive service rejects it with HTTP 403.

Xiaomi system log records at phone time `10:47:24` through `10:48:00` explicitly reported `ActionExecute: frozen uid = 10387 reason=check binder`, with `delayFreeze true reason= screen off uid=10387`. UID `10387` belonged to Termux. Standard Android process diagnostics reported `isFrozen=false` and Termux's foreground service was still present; those standard flags therefore did not establish that the companion was runnable. The phone subsequently reported Awake while the HTTP probe still timed out.

Opening only Termux's existing Activity restored HTTP 403 in `0.183275` seconds. Node PID remained `19690`; Termux and Moose PIDs also remained unchanged. No installer, reconnect action, signed model tool, shell command inside Termux, receipt acknowledgement, or failed-chat retry was run. This captures an alive but unresponsive companion that resumes on foregrounding Termux, strongly supporting Xiaomi freezing as the cause of the observed service outage. The exact original chat failure time and its per-request diagnostics were not captured, so do not claim complete reconstruction of that earlier request.

This is physical-device evidence for the outage mechanism and a foregrounding workaround. It is not physical-device validation of this PR's automatic recovery against Xiaomi freezing. The earlier emulator service-loss test remains separate evidence; ordinary emulator app switching did not reproduce this OEM behavior.

## Android freezer experiment on 2026-10-22

The Android 15/API 35 arm64 emulator exposes `am freeze [--sticky] <PROCESS>`. With real Termux initialized and a successful controlled write/bash response, `adb -s emulator-5554 shell am freeze com.termux` (without `--sticky`) established `isFrozen=true`. Node remained PID `2147`, and an unauthenticated forwarded GET changed from HTTP 403 to a four-second timeout. This uses Android's actual process freezer, not SIGSTOP, but does not reproduce Xiaomi's separate freezing policy.

Two subsequent controlled response admissions successfully woke the existing service without opening Termux's Activity or manually reconnecting. Android logged `sync unfroze 2074 com.termux for 6` immediately before allowing Moose's `com.termux.RUN_COMMAND` intent (at `11:18:18.115` and `11:19:16.595`, emulator time). The existing setup/bootstrap path therefore acts as a native wake-up on stock Android. The service lock prevented a second service instance, and the real write/bash calls completed with Node PID still `2147`. Moose stayed PID `1950`; the cached Harness persisted and controlled request counts advanced `3 → 6 → 9 → 12`. Recovery waits through the initial 15-second RPC timeout; the second observation completed by the 26-second UI snapshot, including automation overhead.

A separate foreground-return experiment confirmed `isFrozen=true` and a two-second HTTP timeout while Moose was hidden. Returning to Moose restored HTTP 403 in 0.13 seconds with the same Node PID; another response completed (controlled count `15`). Android logged thaw reason `1` before the health-check deadline. This establishes stock Android's foreground-related thaw behavior, **not** that Moose's native repair call was needed in that particular case. An earlier attempt without a sustained offline precondition was discarded.

The initial cold-boot attempt also exposed an existing boundary: when Termux had no running process after reboot, `MooseTermux.start` was rejected with `BackgroundServiceStartNotAllowedException`. Opening Termux once and returning to Moose allowed initial connection. Silent recovery of an already-running frozen service should therefore not be advertised as guaranteed cold-start support. Initial setup/launch requirements remain.

These experiments used the existing PR code without implementation changes, real Termux operations and controlled model transport only. No commands or app changes were made on the connected physical phone during the emulator experiments. Xiaomi-specific silent recovery remains unverified; stock Android evidence supports trying it before requiring visible app switching.

### Released-v0.3.0 request diagnostics follow-up

The physical phone's in-app diagnostic list was read after another user report that opening Termux and returning to Moose had not restored chat. Installed version was rechecked as v0.3.0/versionCode 9, not this PR. Records `117–124` contained four consecutive pairs of `exec timeout` then `cancel timeout`, each approximately 15 seconds: UTC `07:12:35/07:12:50`, `09:33:12/09:33:27`, `10:17:37/10:17:52`, and `10:18:51/10:19:06`. There were no later successful requests in that list. These are unknown execution/cancellation outcomes, not proof that commands never ran. No original command was resubmitted.

A captured awake Moose Settings screen still showed last contact at phone time 11:19:06 and the independent HTTP probe timed out. A later screenshot showed the repair/self-test buttons enabled again; their earlier disabled appearance alone does not establish a permanent runtime deadlock. In v0.3.0 those controls are disabled while `moose.working` is true, and returning to the app does not perform a signed health probe, so a previous communication error remains displayed until another request updates diagnostics.

A subsequent Activity-switch experiment had eight-second ADB launch-command timeouts, so the precise Activity transition timing was not established. HTTP later recovered to 403 and remained responsive at the next check about ten seconds later, with the original Node PID 19690. This again establishes transport responsiveness only, not recovery of the earlier chat or signed-tool success. A model-free signed self-test was requested from the user to check the full path. Xiaomi denied ADB input injection; the user opened and scrolled diagnostics manually. No device security settings were changed to bypass that restriction.
