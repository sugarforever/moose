# Conversation attachments

The composer offers Files, Photos, and Take photo. Each message accepts up to four attachments, with an 8 MiB limit on both the original file and its converted result. Images become JPEG with a maximum edge of 2048 pixels. Camera permission is requested on use; the system photo picker needs no broad library permission, and microphone permission is disabled.

## Capture and persistence

`src/platform/attachments.ts` adapts Expo DocumentPicker, ImagePicker, ImageManipulator, and FileSystem. `src/attachments/picker.ts` validates count, size, and names, then captures self-contained bytes before releasing picker-owned cache copies in a finally block. Cleanup deletes only app-cache copies, never original documents or library photos. Native image references are released after conversion.

`src/attachments/drafts.ts` keeps drafts separate per conversation. A selection lease includes the conversation generation: switching away and back invalidates a late result. Unsent drafts remain in memory and are not restored after app exit.

`useMoose` writes text, attachment bytes, and a stable request ID to the SQLite outbox before submission. The engine uses Pi's public custom input-entry API to preserve the display text and attachment bytes in `moose.attachments` entries. Images use real Pi image blocks. Ordinary file bytes are not inserted as Base64 into model text; the engine imports them into `/workspace/attachments/<unique ID>/<filename>` and supplies their paths to the model's read tool. This does not add PDF, Office, or arbitrary binary parsers.

Attachment submissions serialize imports. A retry checks Pi's persisted request record and skips duplicate import, preserving later edits. Explicit resend creates a new request with the original attachment bytes. Existing background execution leases and cancellation checks remain in force. Image submissions reject a model that lacks image input; OpenAI, Anthropic, and Codex retain their own transport and credentials.

Checkpoint branches retain historical attachment bytes and reimport the original ordinary files. Later file edits and other workspace files are not copied or rolled back. Image history needs no picker URI. The app adds no upload backend: messages and file content read by the model go to the selected provider.

## Validation

The implementation was first tested in the original working checkout, then ported onto current main for this PR. These are distinct validation scopes.

Original-checkout evidence (2026-10-23):

- Complete verification passed: 94 tests, strict types, portable runtime smoke, and both Hermes release asset exports.
- iOS Debug build and simulator installation passed with 0 errors and 6 existing build warnings. A first attempt overlapped native configuration generation and failed; the sequential rebuild passed.
- iPhone 17 Pro / iOS 26.2 verified all menu options, system photo selection, JPEG conversion, thumbnail preview, full-size preview and close, removal, and attachment-only send-button enablement. The document picker opened and cancelled without an error. No document was selected in the native picker.
- After sample-photo capture and removal, no image files remained in the app's cache directory, confirming native picker and conversion cleanup.
- Software-keyboard expansion, Android native operation, physical-device capture, and real model inference were not tested. No real account requests or charges occurred.

PR branch rebased onto current main (2449417), 2026-10-23:

- `npm run verify` passed: 262 tests passed and 37 optional native tests skipped; all 3 Termux installer-script tests passed. Strict TypeScript, portable native-tool and Pi / SQLite / Codex smoke checks, and both iOS and Android Hermes release asset exports passed. Each platform export is approximately 5.4 MB; these are resources, not APK or IPA files.
- Added a real filesystem regression proving an already-cancelled execution lease cannot import attachment files and is released without submitting a message.
- `npx expo-doctor` passed 20/20. Prettier checks and `git diff --check` passed.
- npm audit reports 15 high-severity toolchain/transitive findings. Some proposed fixes require downgrading React Native to 0.72.17, incompatible with Expo SDK 58. Toolchain updates remain separate work; no forced downgrade or unrelated dependency change was made. The new picker packages are not named in the audit findings.
- The migrated PR build has not been compiled or exercised natively. Prior simulator results above apply only to the original implementation build. Physical-device capture, Android native attachment operation, software-keyboard layout, and real model requests remain unverified.

Unit tests use real Harness / SQLite and controlled provider responses. The three provider tests inspect image payloads and credential routing without sending network requests. Independent reviews covered both the original implementation and the integration with main's background leases, pending-request recovery, activity rendering, and existing message menus.

## Official API references

- [Expo SDK 58 ImagePicker](https://docs.expo.dev/versions/v58.0.0/sdk/imagepicker/)
- [Expo SDK 58 DocumentPicker](https://docs.expo.dev/versions/v58.0.0/sdk/document-picker/)
- [Expo SDK 58 ImageManipulator](https://docs.expo.dev/versions/v58.0.0/sdk/imagemanipulator/)
- [Expo SDK 58 FileSystem](https://docs.expo.dev/versions/v58.0.0/sdk/filesystem/)
