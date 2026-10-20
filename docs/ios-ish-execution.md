# iOS iSH execution design and acceptance

Issue: https://github.com/sugarforever/moose/issues/6

## Intended product

An optional iOS ExecutionEnv runs real i386 Linux programs inside the Moose process through iSH's usermode CPU interpreter and syscall layer. File tools and shell must see the same persistent guest workspace. No model credentials, SQLite, SecureStore values, or host home directory may be mounted or inherited. Node execution environments must never enter Hermes.

## Evidence boundary

First build and run a pinned upstream kernel independently of React Native. A standalone native probe is a feasibility artifact, not an enabled Moose feature. Keep the existing Expo file environment until embedding satisfies all acceptance criteria. Do not ship a nonfunctional bash tool or silently substitute a host shell.

Upstream source: https://github.com/ish-app/ish at c5ebcabec14f1d8709e91e1905ce0edd7cb9c13c. README describes usermode x86 emulation, syscall translation, and precompiled threaded interpreter gadgets rather than generated executable code. `meson.build` separates static emulator, fakefs, and kernel libraries from the app frontend. `kernel/task.c` owns a global PID table; `fs/mount.c` owns a global mount list. Thread-local `current` is a task pointer, not an independent kernel instance. `kernel/exit.c` halts/unmounts the kernel when PID 1 dies. `xX_main_Xx.h` adds a host `exit` callback. Embedding must replace that callback and maintain a supervisor init; spawning another kernel per conversation in the same process is unsafe without upstream changes.

## Licensing and redistribution

`LICENSE.md` specifies GPLv3 plus `LICENSE.IOS`, with additional GPLv2 licensing for contributions after the identified commit and named earlier authors. Do not assume every historical contribution can be linked under GPLv2 alone. `LICENSE.IOS` permits otherwise GPL-compliant App Store distribution despite App Store terms; it explicitly retains source and license-text obligations. Before distributing a linked Moose binary, select a compatible whole-program license, include license texts/notices, and provide complete corresponding source and reproducible build instructions for the exact kernel, modifications, frontend and rootfs packages. Source-only feasibility scripts do not make that distribution decision. Rootfs package licenses and sources require a separate manifest. No prebuilt kernel/rootfs is committed here.

## Required architecture

One native kernel supervisor per app process, serialized initialization and shutdown. Each conversation gets an independent persistent guest filesystem with a non-root guest identity and restricted mount/syscall policy. A guest chroot alone is not sufficient if the guest retains root or can mount host paths. iSH's emulator shares Moose's native privileges: it is not an OS security boundary. Disable dangerous host mounts and unnecessary network/devices before model-directed commands are enabled.

The bridge must allocate per-command stdin/stdout/stderr descriptors, encode argv and env as NUL-separated strings with length validation, set guest cwd, stream bounded output with stream identity and omitted-byte accounting, and return exit status. Only explicit environment variables are passed. Cancellation/timeout must signal the entire guest process group, reap descendants, close descriptors, and leave the supervisor and other conversations alive. Never use host process termination as cancellation inside Moose.

Persist workspace files and command intent/status, not CPU registers or credentials. After process death, pending commands become interrupted; do not replay commands with possible side effects. Reconnect by stable command ID where the native process still exists. iOS suspension pauses execution; foreground recovery must reconcile state. No background execution guarantee.

## Acceptance gates

- Real shell pipeline, fork/wait, argv with metacharacters, cwd/env, separate streaming stdout/stderr, and nonzero status in host harness and iOS simulator.
- File read/write/edit and shell share files; reopen preserves them; two conversations and symlink/absolute-path attacks cannot expose another conversation or host data.
- Timeout, cancellation, output flood, descendant cleanup, repeated commands, supervisor survival, and initialization races verified natively.
- Pi Durable real Harness integration and environment conformance with controlled model transport.
- Native device build and simulator interaction; physical-device evidence reported separately. No JIT entitlement required.
- Runtime bundle, tests, types, portable smoke, both resource exports, Expo doctor; native compilation is distinct from resource export.

Until all security/lifecycle gates pass, deliver as draft with actual feasibility results and explicit missing implementation. Do not change the product's advertised capabilities.

## Running the executable probes

These scripts currently target Apple Silicon macOS. Prerequisites: Xcode with an installed iOS simulator runtime, Python 3, Meson, Ninja, LLVM **and LLD** (Homebrew packages are separate), libarchive, pkg-config, git. The scripts do not install dependencies. LLVM is only used to cross-compile the guest i386 VDSO; Apple Clang builds host and iOS code. For example, put Homebrew LLD on PATH before building:

```sh
PATH="$(brew --prefix lld)/bin:$PATH" python3 scripts/ish/build_probe.py \
  --cache /tmp/moose-ish-probe --simulator
xcrun simctl install booted /tmp/moose-ish-probe/MooseISHProbe.app
python3 scripts/ish/test_simulator.py
python3 scripts/ish/audit_guest_boundary.py \
  --runner /tmp/moose-ish-probe/host/moose-ish-probe \
  --root /tmp/moose-ish-probe/root/data
```

Use a dedicated cache outside the repository. The build script fetches the exact iSH commit without changing it and verifies the Alpine 3.23.0 x86 minirootfs SHA-256 against the pinned value. Upstream submodules are not needed for these three static libraries. Rootfs checksum source: https://dl-cdn.alpinelinux.org/alpine/v3.23/releases/x86/alpine-minirootfs-3.23.0-x86.tar.gz.sha256.

`native/ish/probe.c` directly boots the real kernel with bounded argv/env packing. `host.c` is a standalone process adapter; its exit callback may terminate that executable. `simulator.m` instead owns a dedicated pthread and records status without terminating UIKit. iSH tasks call `pthread_exit`; running them on GCD worker threads caused the original native survival regression. A guest PID 1 exit still shuts down the one kernel, so the probe deliberately boots only once per app launch. It is not the required long-lived supervisor.

Host capture in `scripts/ish/host_runner.py` streams separate bytes, limits combined captured output to 1 MiB, and kills/reaps the **entire standalone host process** on timeout or a callback failure. The flood test uses a 64 KiB bound. This is not a solution for per-command mobile cancellation. Simulator commands are fixed, finite probes; they write stdout/stderr to app-private files and do not implement a bounded streaming bridge. Do not put arbitrary model commands into this app.

The simulator test launches the native app twice, checks stream contents/status, verifies the host remains alive after guest exit, and checks persistence on the second launch. The app remains installed under `dev.moose.ishprobe`, separate from Moose. Test artifacts are in its `Documents/probe`. Remove the disposable app with `xcrun simctl uninstall booted dev.moose.ishprobe` when finished. The cache contains local GPL-linked test binaries and rootfs; do not publish that cache without satisfying distribution obligations.

## Actual results, 2026-10-20

| Evidence                                                                 | Result                                                                                                                                                       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fresh scripted host + arm64 iOS simulator build                          | Passed from a new external cache; no upstream source patches                                                                                                 |
| Real Alpine x86 guest tests                                              | 8 passed: argv/cwd/env/exit, fork/pipeline/persistence, empty inherited environment, host timeout, early streaming, output bound, oversize argv, invalid cwd |
| Simulator native execution, iPhone 17 Pro / iOS 26.2, Xcode 26.2         | Passed: shell, literal argv, cwd/env, separate stream files, exit 7, fork/pipeline, UIKit host survival, relaunch persistence                                |
| Probe tooling regression                                                 | Passed: runner failure produces nonzero inconclusive status, never isolation success                                                                         |
| Host boundary audit                                                      | **FAILED / BLOCKER**: guest mounted a newly created host temporary directory and read only its controlled sentinel                                           |
| Project `npm run verify`                                                 | Passed: runtime bundle, 41 tests, TypeScript, portable smoke, Android and iOS Hermes resource exports                                                        |
| `npx expo-doctor`                                                        | 19/20; existing react-native-tcp-socket New Architecture metadata warning                                                                                    |
| Native compiler warnings                                                 | Upstream syscall function-pointer casts and assembly gadget alignment warnings; builds completed, warnings are not claimed resolved                          |
| Physical iPhone, signed device build, app background/foreground recovery | Not performed                                                                                                                                                |
| Pi Durable integration, native bridge, real model calls                  | Not implemented / not performed; no credentials or billable requests used                                                                                    |

The audit is an intentionally red product acceptance gate, separate from the functional probe tests. It exits nonzero when the sentinel becomes visible. It must not be inverted into a passing security test. `fs/mount.c` registers `realfs`, and `sys_mount` passes guest-provided source paths to `realfs_mount`, which resolves and opens host paths. Dropping the guest uid alone is not a demonstrated fix: the inspected syscall does not perform the expected privilege check. This reproducer is why unmodified upstream must not be wired to Moose's model tools.

## Remaining work before #6 can be completed

1. Fork/pin an embedded core policy that denies host filesystem mounts and unintended syscall/device/network capabilities; run native adversarial isolation tests, including other conversations and Moose files. Re-audit path and socket boundaries, not only `mount`.
2. Implement one surviving init/supervisor and per-conversation guest identities/root directories. Keep all shared mounts and tasks behind a serialized native owner. Verify repeated commands and independent process-group cancellation without host exit or kernel shutdown.
3. Implement native descriptor-based streaming with byte bounds, output omission accounting, exit-status events, timeouts, cancellation and idempotent cleanup. Handle callback errors and descendants holding output descriptors.
4. Implement Pi 1.3.0's actual `ExecutionEnv` file contract (`BinaryReader`, line scanning, directory reads, mutation and flush semantics) against the same guest filesystem. The fakefs metadata database means exposing its `data` directory through Expo file APIs is not equivalent to guest file operations. Run Pi's environment conformance and real Harness tests with controlled SSE.
5. Persist stable command IDs/status and reconcile interrupted commands on app restart; do not transparently rerun side effects. Exercise background/foreground and termination on native devices.
6. Decide a compatible linked-app distribution license and corresponding-source delivery for Moose + iSH + bundled packages before distributing binaries. Keep this PR draft until runtime gates are met; do not close #6 as implemented on the strength of these probes.

Apple's background-execution guidance remains applicable to an embedded interpreter: https://developer.apple.com/documentation/uikit/extending-your-app-s-background-execution-time. No probe result establishes continuous execution while iOS suspends the application.
