# Pi Durable Mobile Dependency Assessment

This assessment covers the npm releases of Pi Durable / Pi AI / Chord 1.3.0. Historical projects contained 1.1.0 and 1.2.0; their APIs cannot be assumed identical.

| Component                                 | Dependency or limitation                                      | Handling in this version                                                                                |
| ----------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Harness, Conversation, task state machine | JavaScript, Promise, AbortSignal, Web Crypto randomness, etc. | Runs directly in Hermes                                                                                 |
| Portable SQLite core                      | Requires an asynchronous SqliteDatabase interface             | Expo SQLite with serialized reads/writes and transaction isolation                                      |
| Node SQLite adapter                       | node:sqlite, node:fs, node:path                               | Excluded from the mobile dependency graph                                                               |
| Node execution environment, CodingTools   | Filesystem, child_process, file watching                      | Node environment excluded; read, write, and edit registered through pi-durable-expo-env, excluding bash |
| Code mode, image worker                   | worker_threads, WASM, and other environment capabilities      | Disabled in this version                                                                                |
| Model calls                               | fetch, SSE, ReadableStream, TextDecoder                       | Expo fetch injected into Pi's model streaming implementation                                            |
| Default credential discovery              | Environment variables, user directories, dynamic Node imports | Replaced at build time with explicit mobile credential callbacks                                        |
| Pi OAuth login                            | Node HTTP callback listener and some Node crypto functions    | Module excluded; replaced by independent HTTPS device-code or native TCP + PKCE implementations         |
| Background execution                      | iOS / Android scheduling restrictions                         | Save recovery points and resume on reopening; no promise of precise background timing                   |

The installation tree includes transitive Pi AI dependencies such as AWS and Google packages; this does not mean they enter the mobile bundle. Bundle audits allow only the selected OpenAI and Anthropic implementations in the dependency graph, rejecting Node storage adapters, execution environments, OAuth, Code mode, and unselected model SDKs.

The generated portable JavaScript runtime bundle is about 2.2 MiB. Final platform Hermes bundles also contain React Native and Expo code; their size differs from this runtime bundle.

## Verified

- Conversation persistence, idempotent retries, and historical checkpoint branching with real Pi Durable.
- Recurring task recovery after closing/reopening SQLite, without bulk catch-up after overdue intervals, and with completed counts preserved after stopping.
- SQLite rollback, concurrency isolation, and transaction handle invalidation.
- GitHub URL conversion, single-file Skill downloads, size limits, and HTML rejection.
- Rapid consecutive Skill switches retain updates; removal updates instructions in other conversations.
- Explicit keys and injected fetch in Pi's OpenAI streaming adapter.
- Real Harness conversation execution, saving, and branching in an isolated environment without process, Buffer, or require.
- Android and iOS Metro / Hermes release bundle exports.
- Native build, launch, screen interactions, public GitHub Skill download/activation, and Skill persistence after closing/reopening on the iPhone 17 Pro / iOS 26.2 simulator.

Actual iOS simulator checks also revealed that importing a generic Promise patch replaced React Native's Promise and caused recursion errors. This version only adds the missing withResolvers method, preserving the original Promise implementation; structuredClone uses React Native's implementation. Ordinary Node tests do not expose this issue.

## Dependency audit record

npm audit still reports 22 upstream findings in the installation tree, concentrated in the Expo / Metro toolchain's braces, node-forge, and xcode-to-uuid dependency chains. Compatible fixes were applied. npm's suggested forced fix would downgrade to Expo 44, which is incompatible with this project, so it was not applied. The generated mobile runtime dependency graph excludes all three npm packages. Upstream toolchain fixes still require follow-up before a production release; this record does not claim a clean dependency audit.

## Explicitly unfinished

- ChatGPT / Codex device-code, browser loopback, SecureStore, refresh, and SSE are implemented; real account authorization and inference still need testing.
- Claude.ai subscription login, subject to the provider's current access rules.
- Billed model requests using real API keys.
- Android native installation and physical-device validation, plus store signing and submission.
- Persistent background execution, cross-device synchronization, Skill script execution, and reference resource downloads.

## References

- [Pi Durable source and documentation](https://github.com/earendil-works/pi/tree/main/packages/durable)
- [Expo SQLite](https://docs.expo.dev/versions/latest/sdk/sqlite/)
- [Expo SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/)
- [ChatGPT public client authorization](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Claude Code authentication rules](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)

## Local Expo file environment integration

Moose now injects the device filesystem through the npm-published `pi-durable-expo-env`, reusing Pi's read, write, and edit tools. The platform factory lives in `src/platform/open.ts`; the runtime receives only portable interfaces. Workspaces are isolated per conversation; checkpoints do not save or roll back files. See [File environment integration](mobile-files.md) for detailed semantics, native configuration, and validation for this change.

## Optional iOS iSH environment

`EXPO_PUBLIC_MOOSE_ISH=1` selects the embedded iSH backend, which provides file tools and a POSIX shell through the portable `ExecutionEnv` without introducing Node into Hermes. See the [phone setup guide](ios-ish-setup-guide.md) and [execution notes](ios-ish-execution.md). The default Expo environment has no shell; Android can separately opt into Termux.
