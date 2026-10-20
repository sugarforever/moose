# Termux execution design

Issue: https://github.com/sugarforever/moose/issues/5

## Scope and trust

An opt-in Android execution environment connects to a manually started Termux Node service on 127.0.0.1 only. No SSH or Node module enters Hermes. Local Expo files remain the default. Switching environments requires an app restart and never migrates files. The pairing public-key namespace and conversation IDs select distinct directories; checkpoint branches begin empty.

Termux shell is trusted code with the Termux UID's permissions, including other Termux files. Neither cwd nor PRoot provides OS isolation. File RPC validates paths and refuses symlink traversal, but concurrent hostile shell writers are outside that boundary. Do not use a Termux installation holding private data for untrusted commands. Moose model credentials stay in SecureStore and are never sent to Termux. Pairing uses an Ed25519 private seed in SecureStore and a public key on the service, so commands cannot read a reusable Moose authentication secret from the service filesystem or environment.

## Protocol and lifecycle

Signed JSON POST requests contain a stable tool-task/workspace/operation-sequence ID (random UUID outside tool execution), timestamp, workspace, operation and arguments. The server verifies signatures, freshness, body size and an explicit operation allowlist. Replays with the same ID and different content fail. No request is retried automatically after an ambiguous transport failure. A durable request journal records side-effect intent before execution; after restart journaled operations return an explicit uncertain-outcome error rather than repeating effects. A durable tool replay while the service survives reuses the command ID and polls the retained result; process output is ordered by cursor, with separate stdout/stderr. Retained output has an 8 MiB cap; exceeding it cancels the command with an explicit error. Every started shell command remains unacknowledged on disk until the client consumes its result. A service restart with any unacknowledged command blocks new commands in that workspace until owner acknowledgement; it never guesses whether external side effects completed.

The service uses Pi Durable 1.3.0 NodeExecutionEnv for real files, positional readers, directory readers, shell string/argv, timeout and process-group cancellation. Reader handles belong to a workspace/service instance and expire on cleanup/restart. Watch is explicitly unsupported. File paths and shell cwd refer to the same actual conversation directory. Native shell can still use absolute paths outside it. Cleanup closes readers and cancels all commands owned by that workspace.

## Files and acceptance

- `components/termux-service/`: independent Node service, public-key pairing CLI and durable journal; no model/provider dependencies in its protocol.
- `src/termux/`: portable signed transport and ExecutionEnv adapter.
- `src/platform/termux.ts`: SecureStore configuration and signing seed.
- Settings: Android-only enable/disable plus public pairing key and connection check; restart required.
- Engine: optionally register real bash alongside read/write/edit, all using the selected environment.

Acceptance: real HTTP/file/process integration tests, official registerEnvConformance (unsupported watcher cases reported), authentication/replay, traversal/symlink, separate workspaces, paged readers, stdout/stderr, argv/env/cwd, timeout/cancel/cleanup, ambiguous retries/restart. Run full verify and Expo doctor. Android install and actual Termux smoke are separate required native evidence; absent SDK/device means draft delivery, not a completed support claim. No paid model requests.

## Official constraints checked 2026-10-20

[RUN_COMMAND](https://github.com/termux/termux-app/wiki/RUN_COMMAND-Intent) requires both Android permission and allow-external-apps; background service launch restrictions also apply. Initial delivery deliberately uses explicit manual service startup, avoiding an untested native bootstrap and broader external-app command permission.

[PRoot distro](https://github.com/termux/proot-distro) describes path translation without kernel namespaces/cgroups. PRoot is deferred; do not advertise it as isolation.

[Official pi-env](https://github.com/earendil-works/pi/tree/main/packages/env) provides a Rust daemon and Node Connection/SSH transport. This service preserves Durable's environment contract through the pinned upstream Node implementation, while its transport remains mobile-safe. It does not claim wire compatibility with the pi-env daemon.

## Setup (experimental; native acceptance pending)

1. Build the standalone service on the development computer with `npm ci && npm run bundle:termux`. Copy `dist/termux/service.mjs` to the Android device. This generated artifact is not committed and is independent of the mobile runtime bundle.
2. In Termux install Node with `pkg update && pkg install nodejs-lts`. Check `node --version` is at least 22.19. Copy the service into Termux private storage, for example `~/moose-service.mjs`. No npm install is needed on the phone. Use a dedicated Termux installation without unrelated private data.
3. Rebuild/install Moose's Android development client after this change. The Expo config plugin permits cleartext only for `127.0.0.1`; other HTTP hosts remain blocked in release builds. Debug builds retain HTTP access for emulator/LAN Metro. Open Settings → execution environment and copy the displayed public pairing key (safe to share with your local service).
4. In Termux run `node ~/moose-service.mjs PUBLIC_PAIRING_KEY`. It binds only `127.0.0.1:18765`. It has no bearer token, private signing key, provider key or OAuth token. Keep Termux running; Android may stop background processes. Optional Termux battery/wake-lock configuration cannot guarantee background execution.
5. In Moose tap the Termux connection button. A signed connection probe must succeed before the preference is saved. Fully close and reopen Moose to activate the selected environment. The default remains local files. Disabling Termux also requires restart. Existing and restored conversations use the currently selected environment; files are never copied between providers.

The public pairing key is pinned in the running service process. Restarting with another key changes the authorized Moose installation. App reinstall/key loss requires pairing again; the key namespace prevents accidental reuse of the prior installation's conversation directory. Service data lives at `~/.moose-termux/workspaces/`, request receipts at `~/.moose-termux/.requests/`. `MOOSE_TERMUX_ROOT` may select another private service root for development. Never set it to a shared downloads directory.

Use relative filenames with read/write/edit and bash. `/workspace` is a file API alias, not a physical directory available to shell programs. `pwd` reveals the physical workspace path, which all file APIs also accept. Bash cwd is always resolved to this same directory. Shell `cd` affects only that command. New checkpoint branches have new empty workspaces; no snapshot or rollback is implied.

## Recovery and limits

A lost reply can mean a command already changed a file or an external system. The transport never silently retries an ambiguous request. Pi tool replays carry deterministic request IDs; same-ID/different-content requests fail. While the service lives it retains operation results and ordered command events. After restart, a journaled request fails explicitly instead of re-executing. Inspect effects and issue a new deliberate tool request only when appropriate. This is conservative at-most-once submission, not a transaction across external systems. Receipts must not be removed while old tasks could replay.

If startup detects an unacknowledged shell command, stop Moose work, inspect the workspace and any external effects, stop the service, then run `node ~/moose-service.mjs PUBLIC_PAIRING_KEY acknowledge-interrupted`. This archives unacknowledged command receipts, partial/corrupt receipts and incomplete acknowledgement temporary files and starts the service. It is an explicit owner override: an old task can execute again after its receipt is archived, so cancel/resolve pending tasks before this action. This operation cannot undo network requests or restore files. Keep the service stopped while acknowledging outcomes.

- Whole-file text/binary reads and individual write/append payloads: 1 MiB. Larger files require positional binary-reader pages (up to 1 MiB each).
- Directory-reader pages: up to 1,024 entries; at most 256 readers open across the service. Cleanup closes them. Readers cannot survive a service restart.
- Raw decoded shell output retained: 8 MiB per command. Normal Pi bash spill files stay inside the workspace. Command timeout defaults to 600 seconds; an explicit timeout follows the upstream finite-positive-seconds contract.
- Commands: at most 100 retained per service until workspace cleanup. HTTP signed body: at most 12 MiB; response wait: 15 seconds. Signed timestamps must be within 60 seconds. Up to 10,000 cached state-changing requests before restart is required. Durable receipts remain on disk across restarts.
- File watch is explicitly `not_supported`; optional `listFiles` is absent. File symlink paths are rejected, so the conformance suite runs with `symlinks: false`. Native shell remains able to create/follow symlinks and access other Termux files.
- Cancellation uses upstream POSIX process-group cleanup. Ordinary shell descendants are tested. Programs deliberately escaping their process group/session, service termination by Android, and already committed external effects cannot be rolled back or reliably contained. PRoot, automatic RUN_COMMAND bootstrap, interactive terminals and iOS are not implemented here.
- Shell inherits only an allowlist of basic platform variables, plus caller-supplied env. Arbitrary service environment variables are not forwarded. Termux's own filesystem/process permissions still apply; this service is not a hostile-code sandbox.

## Validation from this branch

Automated tests use real Node filesystem/processes and authenticated loopback HTTP on macOS, plus a controlled faux model through actual Pi tools. `registerEnvConformance` registers the genuine upstream cases; 8 watcher cases are explicitly skipped, and symlink support is disabled by design. This is not a full unqualified conformance pass.

`npm run smoke:termux` builds and launches the standalone bundled CLI, exercises real signed file/shell/stdout/stderr/cleanup calls, exercises explicit recovery from a corrupt receipt, then exercises the browser-bundled adapter in a VM with no Node globals. No real account or model inference is used.

The Android native run was attempted with `npx expo run:android --no-bundler`: Expo prebuild succeeded and generated the loopback-only network security config; launch/build stopped because `/Users/wyang14/Library/Android/sdk` and `adb` are unavailable. No APK compilation, emulator/device operation, Termux Android execution or native UI verification was completed. Delivery must remain draft until those acceptance checks pass. Resource export is not native execution.

Final branch checks: `npm run verify` passed 99 tests (8 watcher cases explicitly skipped), strict TypeScript checks, portable runtime smoke and both Android/iOS Hermes resource exports. `npm run smoke:termux`, Expo Android prebuild and Prettier checks passed. Expo Doctor passed 19/20 checks; the sole remaining check is the existing react-native-tcp-socket New Architecture metadata advisory. The installed dependency tree retains 23 upstream npm audit advisories (8 moderate, 15 high); no forced dependency downgrade was applied. Independent review findings for UTF-8 chunking, interrupted journal recovery and debug Metro network access were fixed and re-reviewed.

## Execution ownership after integration with native tools

Termux mode registers read/write/edit/bash for execution and omits the duplicate native HTTP, database, JSON-import, document and workspace-list tools. Existing native stores and grants remain intact; switching back to the local environment restores those tools and data. Native data is not migrated into Termux or automatically deleted.

Keep three app bridges in Termux mode: capabilities discovery, skill_resource_read (bounded resources with existing native authorization), and artifact_create (publishing bounded HTML/text to Moose's offline preview/share UI). These do not introduce another general computation or document/database workspace. New Termux files do not automatically appear as artifacts; publishing through artifact_create remains explicit.

Native HTTP grants constrain only native resource/tools access. Shell can perform its own network and filesystem operations with Termux permissions; the settings UI must not imply native origin grants constrain bash. iOS and Android local-file users retain all existing native tools. Further Codemode/eval, custom transform DSL expansion and complex native HTTP features are deferred; a PRoot/iSH backend is not a prerequisite for Termux delivery.

MobileEngine.open keeps the native capability options in argument six and adds execution options in argument seven. This preserves existing hosts/tests and allows native artifact/Skill bridges to share the existing data service lifecycle even when execution tools are filtered.

Profile integration regression checks cover hidden execution tools, actual report creation through the retained bridge, and native document persistence across local → Termux → local reopen. Independent integration review found no actionable defects. Both profiles preserve the same native database keys and artifact readers. No Codemode runtime was enabled or removed; future eval/custom execution expansion is deferred.
