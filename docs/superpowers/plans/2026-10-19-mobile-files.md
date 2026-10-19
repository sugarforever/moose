# Mobile filesystem integration plan

Goal: integrate the local pi-durable-expo-env release into Moose, enabling Pi read/write/edit without Node or shell execution.

Architecture: install a committed local tarball so npm ci is reproducible without the sibling checkout or source symlinks. Inject an Expo workspace factory from src/platform/open.ts into MobileEngine; a portable workspace pool caches one environment per conversation and cleans up after Harness closes. The registry advertises only the three supported tools and a short workspace instruction. Existing tests without a platform factory keep working without filesystem tools.

Semantics: conversation IDs map to stable moose-chat-<id> private workspaces. Reopening SQLite preserves files. A checkpoint forks messages into a new conversation with a new empty workspace; it does not snapshot or roll back disk files. Skills remain instructions and cannot execute scripts. No file browser/import UI in this change.

Acceptance:

- [x] Test a scripted model calling genuine write/edit/read through MobileEngine, persistence across restart, conversation/fork isolation, traversal failures and cleanup.
- [x] Implement tool registration, workspace pool, native injection and suppress empty tool-call-only chat bubbles.
- [x] Verify generated runtime, all tests, types, portable isolation and both Hermes exports.
- [x] Run a development-only native smoke fixture using a separate SQLite database and workspace prefix; no user credentials or model network calls.
- [x] Document the local dependency, file semantics and actual native results; independently review before delivery.
