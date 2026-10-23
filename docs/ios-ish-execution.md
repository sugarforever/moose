# Optional iOS iSH execution environment

Issue: https://github.com/sugarforever/moose/issues/6 · implementation: https://github.com/sugarforever/moose/pull/7

Moose can opt into a real local iSH-backed Pi Durable `ExecutionEnv` on iOS. The Hermes runtime calls a local React Native module; the module links the pinned iSH CPU/syscall core. The existing Expo filesystem remains the default, including on Android. There is no remote host, host-shell substitute, Node execution environment, or automatic credential inheritance.

## Build and enable

For step-by-step installation, troubleshooting and acceptance recording, use the [iOS iSH setup guide](ios-ish-setup-guide.md).

Requires Apple Silicon macOS, Xcode with an installed iOS simulator runtime, Python 3, Meson, Ninja, Clang/LLVM **and LLD**, libarchive, pkg-config and git. Scripts do not install dependencies. LLD is a separate Homebrew package.

```sh
npm ci
PATH="$(brew --prefix lld)/bin:$PATH" npm run prepare:ish
EXPO_PUBLIC_MOOSE_ISH=1 npm run ios
```

Preparation downloads iSH at `c5ebcabec14f1d8709e91e1905ce0edd7cb9c13c`, verifies Alpine 3.23.0 x86 minirootfs SHA-256, and builds arm64 device/simulator static libraries and an XCFramework. Generated binaries, rootfs and native projects are ignored. The local module autolinks only when prepared artifacts exist (or `MOOSE_ISH_NATIVE=1` explicitly forces it). Rebuild the development client after preparation or native changes; Expo Go cannot load this module. An enabled backend with a missing module fails explicitly instead of silently falling back.

The flag selects a different persistent filesystem. Existing Expo workspace files are not migrated into iSH. Switching it off returns to the original Expo files. Within iSH each conversation owns a full private guest root; `/workspace` is shared by Pi read/write/edit and shell commands. Checkpoint branches get new roots and do not snapshot or roll back files.

## Runtime ownership

`native/ish/embedded.c` owns one neutral supervisor and serializes guest commands. `embedded-policy.patch` adds an inherited task domain and selects the filesystem root by domain, instead of pretending process-global iSH PID/mount tables are separate kernel instances. The guest runs as uid/gid 501; setuid/setgid exec elevation is suppressed. Host mounts/unmounts, sockets, ptrace, privileged device/chroot operations, cross-domain signals, and cross-process resource-limit changes are denied. No procfs or Moose/SecureStore/SQLite directory is mounted. Only explicit argv/env and three command descriptors cross the boundary.

Cancellation targets every task in the domain, including descendants which changed session or process group. The supervisor survives command exit. Queued cancellation is checked before admission, timeouts include queue time, and completion waits for descendant teardown/reaping. The core uses dedicated pthreads; guest `pthread_exit` must never run on a GCD worker. The original probe caught that lifecycle mistake natively.

The original unmodified iSH probe reproduced `mount -t real` exposing a controlled host directory. The embedded policy denies that operation; the executable boundary audit remains available for comparison. Review and tests also found upstream PID-boundary, negative process-group locking, and truncate64 host-abort paths; the patch includes their regression fixes. This is an experimental embedded interpreter sharing the app's OS process, not a separately sandboxed Linux VM.

`modules/moose-ish/ios/MooseISH.m` clones the complete fakefs seed atomically per workspace, pumps stdin/stdout/stderr concurrently, emits byte-stream events before promise settlement and persists a host-side command journal. A process-wide coordinator owns jobs, admission and the journal across React Native bridge generations; invalidating a generation cancels only its commands and prevents new admission through that module. Guest files and fakefs metadata always change through iSH. Pi's portable file adapter is backed by controlled guest filesystem commands, never by writing directly into fakefs `data` through Expo.

`src/runtime/ish.ts` implements shell strings/argv, cwd/env, independent UTF-8 stream decoders, cancellation, spill files, binary file tools, no-follow reader checks, flush and bounded polling watchers. Complete file operations serialize with shell operations. Polling watches can miss changes that occur and are undone between polls, and wait behind a running guest command. Pi `bash` uses the guest POSIX `/bin/sh`; Bash extensions and unsupported Linux syscalls are not promised. Network access is unavailable.

## Durability and limits

Pi shell tools are explicitly `replay: unsafe`. Before shell effects, the tool stores a stable native command ID with Pi's durable `api.memo`. The native journal stores only ID/workspace/status/exit code, never argv, stdin, environment or model credentials. IDs are never evicted or automatically re-executed. A running record becomes interrupted when the process-wide coordinator first opens after process death; malformed/unreadable journals disable execution. File contents persist, but CPU state and a killed process cannot be resumed. The existing Pi transcript records interrupted unsafe tools; the user can deliberately rerun with a new submission.

- Pi file transfers: 8 MiB per file, inherited from the portable file adapter.
- Native capture: 16 MiB combined stdout/stderr; overflow cancels and reports an error. Input: 16 MiB per command, 32 MiB across admitted jobs.
- Native admission: four jobs, including queued jobs and pending promise settlements. Busy rejection happens before guest effects or journaling.
- Journal and pre-registration cancellation sets: 10,000 IDs each, fail closed at capacity. Internal filesystem helper executions also consume journal IDs. This is a finite experimental ledger, not an indefinitely growing history; there is no automatic destructive reset or eviction.
- Native core: 32 task slots per active domain, including threads and unreaped zombies; 16 MiB per regular file; 256 MiB combined guest mapping backing; 16 MiB syscall transfer buffers and at most 1,024 vector entries. Checks run in actual allocation/I/O paths. Mapping backing is not a bound on total app RSS, emulator metadata or every host allocation. Unsupported `RLIMIT` metadata is not treated as enforcement.
- Commands default to 120 seconds in the Pi adapter; explicit timeout is at most 86,400 seconds.

These bounds do not impose an aggregate on-disk workspace quota. iOS suspension can pause the entire app; foreground recovery reconciles persisted Pi/native state and does not promise background execution. No keychain credential is passed into the guest or stored in its environment.

## Verification

```sh
# Host: builds actual patched iSH, same-kernel lifecycle/resource tests,
# production Objective-C bridge tests, and real Pi/Harness/conformance tests.
PATH="$(brew --prefix lld)/bin:$PATH" npm run test:ish

# Full app JS/portable/Hermes exports; native tests are separate.
npm run verify
npx expo-doctor

# Controlled model transport inside the real iOS app; no real account/request.
EXPO_PUBLIC_MOOSE_ISH=1 EXPO_PUBLIC_MOOSE_FILES_SMOKE=1 npm run ios
```

Use `MOOSE_ISH_CACHE=/absolute/external/cache` to override the host verifier cache. `prepare:ish` uses `/tmp/moose-ish-embedded`; the lower-level builder also accepts explicit external paths. The host test transport launches the real embedded CLI per call; it does not itself establish same-process lifecycle or mobile cancellation. Those are independently checked by the C suite and the production Objective-C bridge on host/simulator.

Additional native commands are available in `scripts/ish/test_embedded.py`, `modules/moose-ish/tests/run_bridge.py` and `run_bridge_simulator.py`. The last two use a thin React registration shim for standalone harnesses while compiling/executing the actual production bridge. The Moose app smoke additionally validates the real React Native/Hermes bridge with controlled OpenAI SSE, Pi tools, SQLite reopen and checkpoint isolation. Temporary simulator bundles use distinct `dev.moose.ish*test` identifiers. Test artifacts and generated rootfs are not APKs/IPAs and are not committed.

## Validation record, 2026-10-20

- Real host adapter/Harness suite: 29 passed, including the 24 applicable official Pi environment conformance cases (optional `listFiles` is not implemented) and five integration cases, including a 9 MiB spilled shell result.
- Same-kernel native suite: initialization races, repeated commands, isolated roots, argv/env/stdio, timeout/cancel and changed-session descendants; independent-process file reopen.
- Production bridge suite: separate streaming/exit, 8 MiB binary transfer, event ordering, timeout/flood cancellation, stable IDs/journal, early cancellation, resource admission and overlapping bridge generations/invalidation.
- Real Moose Debug iOS build and iPhone 17 Pro / iOS 26.2 simulator: controlled OpenAI SSE → Pi write/edit/bash/read → iSH passed, as did transcript persistence, separate checkpoint workspace, file/SQLite reopen and traversal rejection.
- Standard `npm test`: 45 passed; the 29 native adapter tests are skipped unless the explicit native verifier supplies the real core. TypeScript and runtime bundle passed.
- Expo Doctor: 19/20; React Native Directory reports the existing TCP library as untested and the private local `moose-ish` module as unknown. These metadata warnings are not runtime test results.
- Upstream syscall-cast/gadget-alignment and Xcode script warnings remain. Physical-device operation, signed device app/IPA, background/foreground device behavior and real-account/model requests are not claimed.

Final verification after native resource hardening is recorded in the PR validation notes. Earlier standalone `probe.*` and `simulator.m` files preserve the original one-shot feasibility reproducer; they are not linked into Moose.

## Source, licensing and redistribution

The pin comes from [official iSH](https://github.com/ish-app/ish); [its license notice](https://github.com/ish-app/ish/blob/c5ebcabec14f1d8709e91e1905ce0edd7cb9c13c/LICENSE.md) specifies GPLv3 plus [LICENSE.IOS](https://github.com/ish-app/ish/blob/c5ebcabec14f1d8709e91e1905ce0edd7cb9c13c/LICENSE.IOS), with additional GPLv2 grants for specified contributions. Do not infer a GPLv2-only license for all historical source. The App Store exception retains other GPL obligations.

Local preparation bundles exact upstream notices and a source hash/rebuild manifest. That manifest is explicitly not complete corresponding source. Before distributing **any binary that links iSH**, even with the backend flag disabled, choose a compatible whole-program license and supply applicable license texts, complete corresponding app/kernel/package source and reproducible build instructions. Alpine's package licenses/sources require their own inventory. This PR does not publish binaries, choose the linked app's distribution license or establish App Store approval.

Rootfs checksum source: [Alpine 3.23.0 x86 checksum](https://dl-cdn.alpinelinux.org/alpine/v3.23/releases/x86/alpine-minirootfs-3.23.0-x86.tar.gz.sha256). iOS lifecycle guidance: [Apple background execution](https://developer.apple.com/documentation/uikit/extending-your-app-s-background-execution-time).

## Main integration, 2026-10-21

Merge the Android Termux and native capability changes without changing their setup flow. Identify iSH through its explicit workspace factory capability; keep Termux's execution option and request context intact. Both expose bash, while only Termux uses its reduced native capability profile. Preserve the iSH durable command-ID wrapper and replace historical iSH-specific skill preambles with the current generic native-tool preamble. Verify all profiles with controlled transports, then rerun runtime/export checks.

Fresh-seed verification during the merge exposed a missing `/dev` directory. The embedding owner now creates it before its three guest-only devices and reports initialization errors. A regression checks the device nodes and `/dev/null` write on a fresh cloned seed before resource tests; it failed before this fix. This avoids relying on device directories left by earlier workspace use.

The merge validation passed 140 regular tests, three Termux installer tests, TypeScript, portable runtime smoke, both Hermes exports, the real signed Termux service smoke and 33 iSH adapter/boundary tests. Expo Doctor remains 19/20: TCP New Architecture metadata and missing directory metadata for the two private modules.

The rebuilt Moose Debug client also passed the controlled write/edit/bash/read app smoke on iPhone 17 Pro / iOS 26.2 after the merge. Fresh-root core and production bridge UIKit suites passed with the rebuilt native library. No physical-device or real-model request was performed.

## Main sync and setup guide, 2026-10-23

Merged main `a8e0511` (v0.7.0), preserving its recovery, installed Skill folders and tool-activity summary. The standalone [iOS setup guide](ios-ish-setup-guide.md) follows the Android Termux guide's structure while documenting embedded execution, build flags and the absence of a separate service or connection UI. The iSH Harness test now includes main's advertised `skill_workspace` tool.

Fresh merge checks passed: 237 regular tests (37 optional/skipped), three installer-script tests, TypeScript, portable smoke, both Hermes exports, standalone signed Termux service smoke, host iSH core/production bridge tests and 33 adapter/boundary tests. Expo Doctor reported 20/20 under the current project configuration. The rebuilt Debug app passed the controlled SSE/file/bash/persistence smoke on iPhone 17 Pro / iOS 26.2. No physical-device or real-model requests were performed; standalone UIKit lifecycle results above remain historical evidence from 2026-10-21.
