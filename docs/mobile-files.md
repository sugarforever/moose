# Mobile filesystem integration

Moose consumes the local MIT package `pi-durable-expo-env@0.1.0` from `vendor/pi-durable-expo-env-0.1.0.tgz`. The archive is committed so `npm ci` works without npm publication or a sibling checkout. It is an installed package copy, not a source symlink; this avoids duplicate native modules.

## Runtime path

`src/platform/open.ts` injects `createExpoWorkspace` into `MobileEngine.open`. The portable engine never imports Expo. When the factory exists, the registry installs only Pi's genuine `read`, `write` and `edit` tools, plus a short workspace prompt section. `src/runtime/files.ts` owns one environment per conversation and closes it after Harness finishes closing its tools. Hosts without a factory do not advertise filesystem tools.

Conversation IDs map to `Paths.document/pi-workspaces/moose-chat-<id>`. The model sees `/workspace` paths. Files survive engine/SQLite close and reopen. Conversations have separate workspaces. A checkpoint forks the message history into a new conversation with a new, initially empty workspace. It neither copies nor restores filesystem contents. The original conversation's files remain intact.

The engine upgrades the exact legacy app preamble that denied filesystem tools, both on open and after historical checkpoint restore. It preserves the appended Skill text. The shared `chatMessages` mapper hides tool-call-only assistant entries so completed tool steps do not leave empty chat bubbles; tool results remain in Pi's persisted transcript for subsequent model requests. Checkpoints require an idle run and a completed assistant response, preventing a text-bearing tool call from becoming an incomplete checkpoint.

Limits and unsupported capabilities follow the package: 8 MiB per file, 32 MiB open snapshots per environment, 10,000 directory entries; no shell, script execution, search, watcher, realpath or fsync implementation. The dedicated workspace assumes trusted app/native writers and is not a symlink-safe OS sandbox. There is no document picker or file browser in this integration. Reading a file can send its contents to the selected model provider. Cancellation does not roll back committed file writes.

## Updating the local package

In the sibling package checkout:

```sh
npm run check
npm pack --pack-destination ../moose/vendor
```

In Moose:

```sh
npm install ./vendor/pi-durable-expo-env-0.1.0.tgz
npm run verify
```

For a new version, use that version's filename and remove the superseded vendored archive. Commit the archive together with package.json and package-lock.json. Ordinary edits in the sibling source do not update Moose automatically. After npm publication, the dependency can be switched to the chosen registry version.

## Native build

expo-file-system is an explicit native dependency. Rebuild the development client after installing it. iOS uses `expo-build-properties` with `ios.usePrecompiledModules: false`, compiling matching Expo module sources instead of the precompiled ExpoFileSystem/Core pair that failed at launch in the independent package example. Regenerate native config with Expo Prebuild before rebuilding an existing generated native directory.

## Controlled native smoke test

After building the native client, run a developer-only entry:

```sh
EXPO_PUBLIC_MOOSE_FILES_SMOKE=1 npm start -- --port 8083
```

Or build and launch together on the desired simulator/device:

```sh
EXPO_PUBLIC_MOOSE_FILES_SMOKE=1 npm run ios -- --port 8083
```

The flag is checked together with `__DEV__`; ordinary startup and release builds render the normal app. The fixture uses `moose-files-smoke.sqlite` and `smoke-moose-chat-<id>` workspace IDs, resets only its own database, and removes its test files. It never opens moose.sqlite, SecureStore or real account credentials. A controlled fetch callback returns OpenAI SSE data without making a network request. It verifies the same generated MobileEngine, provider adapter, Pi tools, Expo filesystem and SQLite path used by the app.

The screen and Metro log report eight checks: end-to-end write/edit/read, tool advertisement without bash, read-result feedback to the next model request, no empty tool-only messages, branch isolation, persistence after reopen, traversal rejection and transcript persistence. To leave the fixture, restart Metro without the flag and reload the app. A native smoke pass is protocol/native evidence, not a real model or account test.

## Validation

- 41 automated tests, TypeScript checks, portable runtime smoke and iOS/Android Hermes resource exports passed.
- The first iOS native build succeeded with 0 errors and 6 warnings; the iPhone 17 / iOS 26.2 simulator displayed all eight smoke checks passed using the local archive.
- After aligning Expo to 58.0.16 and expo-font to 58.0.9 (expo-file-system 58.0.10), the final native build succeeded with 0 errors and 7 warnings and all eight smoke checks passed again. Expo Doctor passed 19/20 checks; only the existing react-native-tcp-socket New Architecture metadata warning remains. No exclusion or advisory suppression was added.
- No real model requests, paid inference or account authorization were performed. Android native compilation and device operation remain untested.
