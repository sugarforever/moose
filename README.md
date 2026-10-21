# Moose

Moose v0.3.0 is an open source AI agent for iOS and Android powered by Pi Durable. Expo / React Native provides the interface, Pi Durable runs on the phone's Hermes runtime, and SQLite stores conversations and tasks. Model requests go directly to the provider; no Moose backend is required.

## Features

- Streaming chat, conversation history, and response cancellation. Long-press a sent message to resend it.
- Checkpoints and conversation branches. Save a checkpoint from the conversation's overflow menu and restore it from Tasks.
- Finite recurring tasks with saved progress, cancellation, and recovery after restarting the app.
- Install skills from HTTPS links and enable them independently for each conversation.
- Default file tools from `pi-durable-expo-env`: `read`, `write`, `edit`, and `workspace_list`. Each conversation has a private workspace on the device.
- Optional experimental Termux file and command execution on Android, with in-app setup and connection. Native Termux device validation is still pending; see [setup and limitations](docs/termux.md).
- OpenAI / Anthropic API keys and experimental ChatGPT / Codex subscription sign-in.
- Compact conversations, native message action menus, and keyboard avoidance.

## Local development

Requires Node.js 22.19 or later. The Moose app itself does not run Node.js. Node is used for development, builds, and tests, and by the optional companion service inside Termux.

```sh
npm ci
npm run ios
```

iOS requires macOS, Xcode, and an installed simulator. Android requires Android Studio, Java, the Android SDK, and a running emulator or a physical device with USB debugging enabled:

```sh
npm run android -- --device
```

The first run builds and installs a native development client. **Expo Go is not supported**, because browser subscription sign-in depends on a custom native TCP module.

After installing the development client, start the development server with:

```sh
npm start
```

Press `i` in the terminal to open the iOS simulator app, `a` to open the Android app, or `j` to open React Native DevTools. Ordinary UI changes support Fast Refresh. Run `npm run bundle:runtime` after changing `src/runtime/` or authentication protocols. Run `npm run ios` or `npm run android` again after updating native dependencies.

If an Android device connected over USB cannot reach the development server, run `adb reverse tcp:8081 tcp:8081` and connect to `http://localhost:8081`. Do not forward authentication callback port 1455; the phone listens on that port locally.

## Build and release Android APKs with GitHub Actions

`.github/workflows/build.yml` runs when a `v*` tag is pushed or when **Run workflow** is selected manually. On a GitHub Ubuntu runner, it installs locked dependencies, generates the Pi runtime bundle, runs tests and type checks, then builds an APK with Expo Prebuild and Gradle `assembleRelease`. It does not use EAS cloud builds or require repository secrets.

After a successful build, download `moose-android-test-<run-number>` from the run's **Artifacts** section, extract it, and install the APK. The package includes JavaScript / Hermes assets and starts without Metro or a development computer. Model requests still require network access and your own credentials. Artifacts are retained for 14 days. Successful version-tag builds automatically create a GitHub prerelease with the APK and `service.mjs`; manual builds only upload workflow artifacts.

The APK uses the generated Expo project's default test signing key and is intended for testing. Public distribution requires a separate long-term signing key. Changing signing keys may require uninstalling the old test build, which deletes local conversations and files. The iOS job is explicitly skipped with `if: false`; it does not build an IPA or upload to TestFlight.

## Android in-app updates

Android builds with the updater check GitHub Releases on startup and when returning to the foreground, with at least six hours between automatic checks. In Settings, **App updates** supports manual checks, release notes, downloads, and cancellation. The app verifies the APK's SHA-256, package name, signing certificate, and build number before opening Android's installation confirmation. You may need to allow Moose to install apps. Installation and restart are never automatic.

Update releases require an APK and the matching `moose-update.json`. The tag workflow publishes both, using the tag for the version name and the workflow run number for Android `versionCode`. Existing users must manually install one build containing the updater. Test signing is retained; production signing migration is out of scope. iOS does not display this entry, and TestFlight and OTA are not integrated. See [Android updates](docs/android-updates.md) for the design and verification limits.

## Connect a model

Open **Settings**, select a provider using its brand icon, choose a model, and save. OpenAI uses its wordmark, Anthropic uses its AI mark, and ChatGPT uses its knot logo.

### API keys

OpenAI and Anthropic each require their own API key. API usage is billed separately under the provider's terms. Credentials are saved in the iOS Keychain / Android encrypted storage, never in the conversation database or repository.

### ChatGPT subscription (experimental)

Selecting ChatGPT provides two sign-in methods:

- **Sign in to ChatGPT**: Complete sign-in in the official browser page. The app temporarily listens on `127.0.0.1:1455` for the OAuth callback, validates PKCE and state, and exchanges the authorization code for tokens.
- **Sign in with device code**: Obtain a device code, open the [official authorization page](https://auth.openai.com/codex/device) in a phone or desktop browser, sign in, and enter the code. Your account or workspace must permit device authorization.

Save the ChatGPT connection after authorization. Tokens are stored through SecureStore and refreshed automatically. You can cancel sign-in or sign out. Inference uses a separate Codex SSE channel; failures do not automatically switch to API-key billing. Account eligibility, quotas, and model access are determined by the provider.

If Google sign-in in a simulator stops at a passkey QR-code / Bluetooth step, choose another verification method or complete device-code authorization in a real phone or desktop browser. Full hardware sign-in flows require physical-device validation.

Automated tests use controlled responses, without signing into real accounts or sending billable requests. Real-account authorization, subscription eligibility, and quotas are outside automated validation. See [subscription integration notes](docs/chatgpt-subscription.md) for protocol sources and validation records. Claude.ai / Claude Code subscription sign-in is not supported in this version; Anthropic uses API keys.

## Tasks, checkpoints, and skills

Recurring tasks run immediately for the first iteration, with an interval of at least one minute and a total of 2–100 iterations. Requests receive a stable ID before submission. Unconfirmed submissions can retry the same ID to avoid duplicate queue entries. Stopping a recurring task stops future scheduling; an already submitted response must be stopped separately in the conversation.

Android protects user-initiated finite runs with a bounded foreground service; see [Android foreground execution](#android-foreground-execution). iOS may pause when suspended. Exact recurring execution times are not guaranteed. Reopening recovers committed state, and an overdue recurring task runs once before calculating its next interval. This version has no remote execution host or cross-device synchronization.

Restoring a checkpoint creates a new branch from the corresponding historical message and preserves the original conversation.

Skills support direct SKILL.md links and GitHub file, directory, or repository-root URLs. Installation downloads a Markdown file of at most 128 KiB. Skills are disabled by default. Enabling a skill adds its instructions to the current conversation. The model can read relative text reference files through the resource tool; the first network access requires authorization, and downloads are cached. Scripts are not executed. GitHub directory links must use a single-segment branch name or a commit SHA.

## Conversation file workspaces

Ask the model to write, edit, or read a file such as `notes/todo.md`. Files live in the current conversation's `/workspace` and survive app restarts. Other conversations cannot access them through these tools. There is currently no system document import entry point.

Checkpoints save conversation history, not file snapshots. Restoring one creates a new conversation with an empty workspace. It neither copies the original conversation's files nor rolls back disk contents. The original files remain unchanged.

Individual files are limited to 8 MiB. The default environment supports reading, writing, editing, and directory listing, but not command execution, script execution, or search. Android users can explicitly select Termux in Settings. Switching requires no app restart and does not migrate files. File contents read by tools enter the model context and may be sent to the selected provider.

The file environment uses the published npm package `pi-durable-expo-env@0.1.0`, with its version and integrity pinned in the lockfile. It does not depend on sibling source directories or local package archives. See [file environment integration](docs/mobile-files.md) for update steps, the controlled native test entry point, and validation records.

## Android Termux installation and setup (experimental)

**Set up and connect Termux** in Moose checks and installs Node and locking utilities, deploys the service bundled in the APK, pairs automatically, and connects. You do not need to download or copy `service.mjs`, copy a public key, type a service startup command, or restart Moose to switch environments.

First-time setup still requires these steps:

1. Install a new Moose APK containing the native setup module. Older APKs and Expo Go do not include it; developers must rebuild the native client.
2. Install and open Termux once. Wait for initialization to finish and a command prompt to appear.
3. Open Moose → **Settings** → **Execution environment**, tap **Allow command execution**, and allow commands to run in Termux. If no system prompt appears, or you previously denied permission, tap **Open system settings** and allow it under Moose's app permissions / other permissions.
4. On the same page, long-press to copy the one-time configuration command, tap **Open Termux**, paste and run it, then return to Moose. The complete command is:

```sh
mkdir -p ~/.termux && printf '\nallow-external-apps = true\n' >> ~/.termux/termux.properties && termux-reload-settings
```

5. Tap **Set up and connect Termux**. Keep Moose in the foreground with network access until checks, installation, and connection finish. The initial Termux package download may take several minutes. On success, Moose shows that Termux is connected and switches the current environment to Termux without restarting.
6. Tap **Run self-test (no model)**. It checks signed communication, temporary file writes/reads, and bash in a reserved diagnostic workspace, then removes its temporary directory. It does not use model credentials or change conversation files. A passing self-test checks this execution path at that time; it does not guarantee background availability.

The selected environment is separate from the most recent communication result and timestamp. **View diagnostics** shows up to 40 session-only metadata records that can be selected and copied; restarting Moose clears them. Records contain operation, local correlation number, result, time and duration, without paths, commands, content or credentials. A file-not-found response means the service responded; it is not a connection failure. Timeouts, calling-task cancellation and transport interruption are reported separately; an unexplained native cancellation is not attributed to the user or Android without evidence.

After restarting the phone or after Android terminates Termux, tap **Check or repair connection** in Moose Settings. Use **Use local files** to return to the local environment. Finish or stop active responses, pending submissions, and recurring tasks before switching. Switching does not migrate files or delete native databases or historical reports.

The service listens only on the phone's `127.0.0.1:18765`. The temporary installation port also listens only on loopback. It transfers code bundled in the APK and verifies SHA-256, without shared-storage permission. Moose's private signing seed and model credentials are never passed to Termux. Android may suspend or terminate background processes, so continuous execution with the screen locked is not guaranteed.

Termux commands have that app's file and network permissions and can access other Termux files. Conversation directories and PRoot are not security sandboxes. Native tool permissions do not constrain bash network or file access. Cancelling setup stops waiting and temporary transfers, but does not roll back installed packages. An installer that has already finished downloading may still start the service.

See the [step-by-step phone setup guide](docs/termux-setup-guide.md) for common errors, migration from an existing manual service, and an acceptance checklist. See [Termux notes](docs/termux.md) for technical boundaries and validation records. Android device authorization, deployment, connection, and cancellation still require physical-device acceptance testing; tests and asset exports are not device validation.

## Native tools and permissions

These general native tools serve the default local environment and remain available on iOS and on Android without Termux. Termux mode hides overlapping HTTP, database, JSON import, document, and directory-listing tools, delegating complex execution to bash. It retains `capabilities`, `skill_resource_read`, and `artifact_create` for tool discovery, skill resources, and in-app report publication.

Existing native databases, documents, reports, and permissions are neither deleted nor migrated and remain available after switching back to the local environment. Files in Termux workspaces do not automatically appear in the reports list; explicitly call `artifact_create` to publish previewable HTML or text.

The model can use `capabilities` to inspect tool contracts and currently enabled skill IDs. Native tools support HTTPS GET, separate skill SQLite databases, declarative JSON imports, cross-conversation documents, and HTML / text reports. Tools work without installing or enabling a skill and default to the current conversation's private scope. Pass `skillId` only when accessing shared skill data; the skill must be installed and enabled in the current conversation. Skill resource reads always require a skill ID. Skill content cannot grant itself permissions.

The app requests authorization on first access to an HTTPS origin, database reads or writes, or cross-conversation skill documents. Grants apply only to the selected scope in the current conversation. General tools and individual skills have separate permissions, which can be revoked in Settings; revocation stops the current response. Database write permission does not include read permission. Tools do not use model-provider API keys, OAuth tokens, or browser cookies.

HTTP responses are stored by reference, limited to 8 MiB with a 30-second timeout. Redirects are checked and authorized individually. `json_import` transforms data on the device and writes it to SQLite without sending the entire JSON payload to the model. Databases use separate files and cannot access Pi internals. Queries generate parameterized SQL from table names, fields, conditions, ordering, and limits, return at most 200 rows, and do not accept arbitrary SQL. Migrations support creating tables and adding fields; writes support primary-key upserts.

Writes, imports, document changes, and report generation require a stable `operationId`. Retries reuse the ID; changing parameters while reusing an ID is an error. Data and operation receipts commit in one transaction. Failed batches roll back, and successful refresh timestamps advance only after a complete import commits. Execution is still not guaranteed while the app is suspended.

Databases, documents, and HTTP responses without a skill ID belong to the current conversation, survive restarts, and are inaccessible to other conversations or new checkpoint branches. Skill databases and shared documents survive restarts, conversation changes, and checkpoint branches; new conversations require fresh authorization. Uninstalling a skill revokes tool access but retains data for reinstallation. Conversation workspaces remain isolated, and checkpoints do not snapshot files. Individual documents and reports are limited to 512 KiB. Document and resource reads are paginated, and their contents may be sent to the selected model provider.

After generating a report, open **Files and reports** from the conversation's overflow menu to preview it, or tap **Share or export** to open the system share sheet. In-app HTML previews disable JavaScript, external resources, and navigation. Sharing requires an explicit user tap. Rebuild the development client after adding native dependencies.

See [native tool design](docs/portable-agent-tools.md) for tool boundaries, persistence semantics, and validation notes. Developers can open an isolated native test entry point with `EXPO_PUBLIC_MOOSE_CAPABILITIES_SMOKE=1 npx expo start --dev-client`. It uses a dedicated SQLite database and controlled responses without accessing user data or real models.

## Validation

```sh
npm run verify
npx expo-doctor
```

`verify` covers runtime bundle generation, unit and integration tests, 3 real installer-script tests, TypeScript checks, the Pi Durable / SQLite / simulated Codex path without Node globals, and Android and iOS Hermes release asset exports.

Current validation coverage:

- iOS: Native debug build, installation, and operation on an iPhone 17 Pro simulator. Checks covered chat layout, message menus, keyboard avoidance, skill downloads and persistence, and local authentication callback listening and cancellation cleanup.
- Android: Debug APK compilation, installation on an Android 35 emulator, and controlled foreground-service SSE / local file-tool / next-round execution with SQLite commits, Activity destruction/recreation, notification stopping, and force-stop persistence passed. Physical-device Doze, vendor power policies, the full 30-minute timeout, and real Termux operations remain unverified. Release assets exported successfully. [GitHub Actions successfully compiled a test APK](https://github.com/sugarforever/moose/actions/runs/39503789329) containing the native Termux setup module. Phone installation, permission grants, and real Termux operations have not yet been validated.
- Expo Doctor: 19 of 20 checks passed. The remaining check concerns new-architecture metadata for the TCP library and missing public-directory metadata for the local Termux module; this is not a fully passing result.
- File environment: The local package completed real file reads, writes, edits, SQLite reopening, and workspace isolation checks on the iOS simulator using controlled OpenAI SSE responses, without real credentials or billable requests.

`dist/` contains JavaScript / Hermes release assets, **not an APK or IPA**. Build native apps locally or use the repository's EAS development, preview, and production configurations. EAS builds require your own Expo project, signing, and device configuration. EAS cloud builds and store publication have not been validated for this version. GitHub Actions test APK compilation is documented above.

### Known dependency limitations

- React Native Directory lists `react-native-tcp-socket` as untested with the new architecture. The current iOS development build has been verified to run; Android physical-device compatibility remains unverified.
- The dependency tree has documented upstream npm audit findings involving the Expo / Metro toolchain. Expo has not been forcibly downgraded to remove these warnings. See [mobile feasibility notes](docs/mobile-feasibility.md).

## Code structure

```text
App.tsx                    Conversation UI, navigation, and message menus
src/ui/                    Tasks, skills, settings, and app state
src/runtime/               Pi Durable sessions, recurring tasks, checkpoints, and model adapters
src/auth/                  Portable device-code and PKCE protocols with injected TCP callbacks
src/platform/              Expo SQLite, SecureStore, browser, fetch, and Hermes compatibility
src/storage/database.ts    Serialized SQLite adapter and transaction isolation
src/skills/skills.ts        Skill URLs, download limits, and instruction selection
scripts/                   Runtime bundling, dependency audits, and portable runtime tests
tests/                     Protocol, storage, task, and recovery tests
```

Pi Durable / AI / Chord are pinned to 1.3.0. Portable entry points are prebundled with esbuild, excluding Node credential autodiscovery and OAuth callback servers. Platform capabilities are injected explicitly. Generated `src/generated/`, `ios/`, `android/`, and `dist/` directories are not committed and are regenerated during builds and validation.

See [AGENTS.md](AGENTS.md) for development constraints and [chat layout notes](docs/chat-layout.md) for interface design. Brand icon sources and licenses are documented in [assets/brands](assets/brands/README.md).

## Android foreground execution

On Android, a user-initiated answer or finite task establishes a shared foreground service and notification before model work begins. The existing Hermes runtime and Pi Harness continue the same SSE, local tools and SQLite commits when the Activity is hidden. Returning to the app does not resubmit, reopen the Harness or resume it again. Notification permission is required; a denied permission or failed service handshake prevents model execution.

Automatic compaction runs as part of the active answer rather than as speculative background work. All active conversations share the service. The last run releases it; each continuous service generation has a 30-minute execution budget and a bounded partial wake lock. The notification's Stop action cancels all answers and recurring tasks, including future iterations. If JavaScript cannot acknowledge cancellation within 10 seconds, the native service terminates this process; a persistent cancellation marker is processed before recovery on the next manual launch. A missing startup handshake triggers cancellation after 15 seconds.

Recurring tasks do not hold the service while waiting. An iteration due while the app is hidden waits until Moose is visible unless another active run already holds the service. There is no scheduled background wakeup, boot receiver or automatic service restart. A tool requiring new permission stores the pending permission scope and prompts the user to open Moose; it never grants permission automatically. Termux is a separate app and is not kept alive by Moose's service. Switching execution environments is blocked while any conversation, repeat, pending request or foreground admission is active.

System reclamation, Doze, network loss and vendor power policies can still interrupt execution. Process death cannot preserve the original TCP connection or Promise, and recovery cannot guarantee a model is billed only once. Force-stop is respected. iOS retains its existing suspension behavior. The Android `specialUse` declaration describes finite AI work; this does not imply Google Play approval.

For a controlled native probe, rebuild the Android development client and run `EXPO_PUBLIC_MOOSE_BACKGROUND_SMOKE=1 npx expo start --dev-client`. Tap Run background probe, confirm the service starts, then press Home. After 15 seconds the probe should finish its file tool and second model round, commit SQLite and release its notification. The probe uses a separate database and controlled SSE, never real credentials or paid requests. Notification stopping can be checked during the delay.
