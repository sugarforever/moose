# Termux execution design

Issue: https://github.com/sugarforever/moose/issues/5

## Scope and trust

An opt-in Android execution environment connects to an app-provisioned Termux Node service on 127.0.0.1 only. No SSH or Node module enters Hermes. Local Expo files remain the default. Switching environments safely reopens the runtime inside the app after idle checks and never migrates files. The pairing public-key namespace and conversation IDs select distinct directories; checkpoint branches begin empty.

Termux shell is trusted code with the Termux UID's permissions, including other Termux files. Neither cwd nor PRoot provides OS isolation. File RPC validates paths and refuses symlink traversal, but concurrent hostile shell writers are outside that boundary. Do not use a Termux installation holding private data for untrusted commands. Moose model credentials stay in SecureStore and are never sent to Termux. Pairing uses an Ed25519 private seed in SecureStore and a public key on the service, so commands cannot read a reusable Moose authentication secret from the service filesystem or environment.

## Protocol and lifecycle

Signed JSON POST requests contain a stable tool-task/workspace/operation-sequence ID (random UUID outside tool execution), timestamp, workspace, operation and arguments. The server verifies signatures, freshness, body size and an explicit operation allowlist. Replays with the same ID and different content fail. No request is retried automatically after an ambiguous transport failure. A durable request journal records side-effect intent before execution; after restart journaled operations return an explicit uncertain-outcome error rather than repeating effects. A durable tool replay while the service survives reuses the command ID and polls the retained result; process output is ordered by cursor, with separate stdout/stderr. Retained output has an 8 MiB cap; exceeding it cancels the command with an explicit error. Every started shell command remains unacknowledged on disk until the client consumes its result. A service restart with any unacknowledged command blocks new commands in that workspace until owner acknowledgement; it never guesses whether external side effects completed.

The service uses Pi Durable 1.3.0 NodeExecutionEnv for real files, positional readers, directory readers, shell string/argv, timeout and process-group cancellation. Reader handles belong to a workspace/service instance and expire on cleanup/restart. Watch is explicitly unsupported. File paths and shell cwd refer to the same actual conversation directory. Native shell can still use absolute paths outside it. Cleanup closes readers and cancels all commands owned by that workspace.

## Files and acceptance

- `components/termux-service/`: independent Node service, public-key pairing CLI and durable journal; no model/provider dependencies in its protocol.
- `src/termux/`: portable signed transport and ExecutionEnv adapter.
- `src/platform/termux.ts`: SecureStore configuration and signing seed.
- Settings: Android-only guided setup, owner permissions, automatic pairing and guarded live environment switching.
- Engine: optionally register real bash alongside read/write/edit, all using the selected environment.

Acceptance: real HTTP/file/process integration tests, official registerEnvConformance (unsupported watcher cases reported), authentication/replay, traversal/symlink, separate workspaces, paged readers, stdout/stderr, argv/env/cwd, timeout/cancel/cleanup, ambiguous retries/restart. Run full verify and Expo doctor. Android install and actual Termux smoke are separate required native evidence; absent SDK/device means draft delivery, not a completed support claim. No paid model requests.

## Official constraints checked 2026-10-20

[RUN_COMMAND](https://github.com/termux/termux-app/wiki/RUN_COMMAND-Intent) requires both Android permission and allow-external-apps; background service launch restrictions also apply. Automatic setup uses this explicit user-granted interface; neither the Android permission nor allow-external-apps is enabled silently. The native bridge executes a fixed owner-initiated installer, not agent-supplied code.

[PRoot distro](https://github.com/termux/proot-distro) describes path translation without kernel namespaces/cgroups. PRoot is deferred; do not advertise it as isolation.

[Official pi-env](https://github.com/earendil-works/pi/tree/main/packages/env) provides a Rust daemon and Node Connection/SSH transport. This service preserves Durable's environment contract through the pinned upstream Node implementation, while its transport remains mobile-safe. It does not claim wire compatibility with the pi-env daemon.

## Guided setup (experimental; native acceptance pending)

See [the step-by-step phone manual](termux-setup-guide.md). Owners install/init Termux, grant Android RUN_COMMAND permission and run one fixed command enabling allow-external-apps. Moose then installs required Node/lock tools, transfers the service bundled in its APK over a short-lived random-token loopback endpoint, verifies its SHA-256 and deploys it in Termux private storage. No shared-storage permission, manual service file transfer, public-key copying or restart of Moose is required.

The local Expo module is under vendor/moose-termux-native. Expo prebuild packages a freshly bundled service as a native asset. It uses an explicit Termux service Intent with bounded arguments and a private PendingIntent receiver; each callback/transfer is scoped to a setup generation and canceled/expired callbacks are ignored. Termux must be com.termux with the official-compatible RUN_COMMAND interface. The native module must be compiled into a new APK/development client.

The installer uses kernel-held flock descriptors (install and service lifetime), automatically installing util-linux only when needed. Locks release on process death; persistent lock files are not deleted and do not prevent recovery after Android force-stop/reboot. It never kills an unrelated PID. Canceling setup closes the temporary transfer and stops waiting, but does not roll back installed packages and cannot undo a command already launched inside Termux.

Moose keeps its private signing seed in SecureStore and passes only the public key into Termux. Signed serviceInfo must match the bundled asset hash, then a signed workspace probe must pass before selection is saved. An unknown, differently paired or mismatched already-running service is rejected explicitly; the app does not kill it or silently replace another owner's listener. An old manually started service must be stopped by its owner once before migration.

Runtime switching blocks live conversations, active repeat tasks and pending submissions. It closes the old engine/database before opening another owner; failed initialization closes its resources, restores the prior preference and attempts reopening. A failure of that recovery remains visible with a retry button. Data stores and conversations remain intact, and existing watchers reattach without restarting the app. Native databases and Termux files are never copied into each other.

## Recovery and limits

A lost reply can mean a command already changed a file or an external system. The transport never silently retries an ambiguous request. Pi tool replays carry deterministic request IDs; same-ID/different-content requests fail. While the service lives it retains operation results and ordered command events. After restart, a journaled request fails explicitly instead of re-executing. Inspect effects and issue a new deliberate tool request only when appropriate. This is conservative at-most-once submission, not a transaction across external systems. Receipts must not be removed while old tasks could replay.

If startup detects an unacknowledged shell command, stop Moose work, inspect the workspace and any external effects, stop the service, then use the developer CLI `node ~/.moose-termux/service.mjs PUBLIC_PAIRING_KEY acknowledge-interrupted` with the installation’s public key. This remains an advanced owner recovery action; automatic setup does not confirm unknown external effects on the owner’s behalf. If you do not have the public key/old launch command, report the error rather than deleting receipts. This archives unacknowledged command receipts, partial/corrupt receipts and incomplete acknowledgement temporary files and starts the service. It is an explicit owner override: an old task can execute again after its receipt is archived, so cancel/resolve pending tasks before this action. This operation cannot undo network requests or restore files. Keep the service stopped while acknowledging outcomes.

- Whole-file text/binary reads and individual write/append payloads: 1 MiB. Larger files require positional binary-reader pages (up to 1 MiB each).
- Directory-reader pages: up to 1,024 entries; at most 256 readers open across the service. Cleanup closes them. Readers cannot survive a service restart.
- Raw decoded shell output retained: 8 MiB per command. Normal Pi bash spill files stay inside the workspace. Command timeout defaults to 600 seconds; an explicit timeout follows the upstream finite-positive-seconds contract.
- Commands: at most 100 retained per service until workspace cleanup. HTTP signed body: at most 12 MiB; response wait: 15 seconds. Signed timestamps must be within 60 seconds. Up to 10,000 cached state-changing requests before restart is required. Durable receipts remain on disk across restarts.
- File watch is explicitly `not_supported`; optional `listFiles` is absent. File symlink paths are rejected, so the conformance suite runs with `symlinks: false`. Native shell remains able to create/follow symlinks and access other Termux files.
- Cancellation uses upstream POSIX process-group cleanup. Ordinary shell descendants are tested. Programs deliberately escaping their process group/session, service termination by Android, and already committed external effects cannot be rolled back or reliably contained. PRoot, interactive terminals and iOS are not implemented here.
- Shell inherits only an allowlist of basic platform variables, plus caller-supplied env. Arbitrary service environment variables are not forwarded. Termux's own filesystem/process permissions still apply; this service is not a hostile-code sandbox.

## Validation from this branch

Automated tests use real Node filesystem/processes and authenticated loopback HTTP on macOS, plus a controlled faux model through actual Pi tools. `registerEnvConformance` registers the genuine upstream cases; 8 watcher cases are explicitly skipped, and symlink support is disabled by design. This is not a full unqualified conformance pass.

`npm run smoke:termux` builds and launches the standalone bundled CLI, exercises real signed file/shell/stdout/stderr/cleanup calls, exercises explicit recovery from a corrupt receipt, then exercises the browser-bundled adapter in a VM with no Node globals. No real account or model inference is used.

The Android native run was attempted with `npx expo run:android --no-bundler`: Expo prebuild succeeded and generated the loopback-only network security config; launch/build stopped because `/Users/wyang14/Library/Android/sdk` and `adb` are unavailable. No APK compilation, emulator/device operation, Termux Android execution or native UI verification was completed. Delivery must remain draft until those acceptance checks pass. Resource export is not native execution.

Final branch checks: `npm run verify` passed 119 Vitest tests and 3 real shell installer tests (8 watcher cases explicitly skipped), strict TypeScript checks, portable runtime smoke and both Android/iOS Hermes resource exports. `npm run smoke:termux`, Expo Android prebuild and Prettier checks passed. Expo Doctor passed 19/20 checks; the remaining metadata check reports the existing react-native-tcp-socket New Architecture advisory and missing public directory metadata for the local moose-termux-native module. The local module uses Expo’s exported native-module API and does not install expo-modules-core directly. The installed dependency tree retains 23 upstream npm audit advisories (8 moderate, 15 high); no forced dependency downgrade was applied. Independent review findings for UTF-8 chunking, interrupted journal recovery and debug Metro network access were fixed and re-reviewed.

## Execution ownership after integration with native tools

Termux mode registers read/write/edit/bash for execution and omits the duplicate native HTTP, database, JSON-import, document and workspace-list tools. Existing native stores and grants remain intact; switching back to the local environment restores those tools and data. Native data is not migrated into Termux or automatically deleted.

Keep three app bridges in Termux mode: capabilities discovery, skill_resource_read (bounded resources with existing native authorization), and artifact_create (publishing bounded HTML/text to Moose's offline preview/share UI). These do not introduce another general computation or document/database workspace. New Termux files do not automatically appear as artifacts; publishing through artifact_create remains explicit.

Native HTTP grants constrain only native resource/tools access. Shell can perform its own network and filesystem operations with Termux permissions; the settings UI must not imply native origin grants constrain bash. iOS and Android local-file users retain all existing native tools. Further Codemode/eval, custom transform DSL expansion and complex native HTTP features are deferred; a PRoot/iSH backend is not a prerequisite for Termux delivery.

MobileEngine.open keeps the native capability options in argument six and adds execution options in argument seven. This preserves existing hosts/tests and allows native artifact/Skill bridges to share the existing data service lifecycle even when execution tools are filtered.

Profile integration regression checks cover hidden execution tools, actual report creation through the retained bridge, and native document persistence across local → Termux → local reopen. Independent integration review found no actionable defects. Both profiles preserve the same native database keys and artifact readers. No Codemode runtime was enabled or removed; future eval/custom execution expansion is deferred.

## Automatic onboarding validation

Controlled setup tests cover prerequisites, exact service identity, reuse, cancellation, timeout, failed and late native calls, bounded cleanup and retry. Real shell tests cover verified transfer, checksum rejection, concurrent-install rejection and retries after SIGKILL of both installer and an actual Node process. On macOS the tests use Python’s real flock syscall adapter because util-linux CLI is absent. Real SQLite regressions verify initialization failures release ownership and local/Termux switching preserves existing data. Native API calls and actual Android Termux behavior still require separate native/device evidence.

## v0.2.1 validation and diagnostics

The settings page separates the selected environment from the last observed communication result and time. RPC deadlines, caller-context cancellation, HTTP rejection, protocol failures, and unexplained native transport interruption are classified separately. Normal file errors establish service reachability. Up to 40 session-only metadata records retain allowlisted operations/results/error codes and local correlation numbers; no request arguments, paths, commands, raw errors, signatures or credentials are retained.

The model-free self-test uses a fresh reserved workspace namespace and temporary directory per run. It checks signed connection, write/read, bash output and cleanup. Temporary directories are removed on a best-effort basis, including after failure/cancellation. Empty workspace roots and existing service request receipts remain; the service's persistence and replay protections are unchanged. A fresh namespace prevents an interrupted diagnostic shell outcome from blocking later self-tests after service restart.

Validation on this change: controlled real HTTP/file/bash tests, failure and cancellation cleanup, restart with unknown shell outcome, runtime bundling, TypeScript, portable smoke, and iOS/Android Hermes asset exports. The standalone companion smoke also runs without model requests. Expo Doctor reports 19/20 checks; the remaining React Native Directory check flags the existing TCP library's new-architecture metadata and the local Termux module's missing metadata. Local verification reused an existing dependency installation after a disk-space failure; the release workflow performs a fresh locked install and native APK compilation.

No Android emulator or Xiaomi device was operated for this change, and no real model/account requests were made. User screenshots from v0.2.0 showed a file-not-found response after reconnecting and then a reported successful write/bash read; these are user-reported observations, not independent filesystem verification or v0.2.1 acceptance. Original intermittent first-connection failure remains unproven; v0.2.1 improves the evidence available for investigation rather than claiming its root cause is fixed.
