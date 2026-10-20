# Optional iOS embedded execution

This private local React Native package registers `NativeModules.MooseISH` on iOS.
Android has no module. The application chooses whether to use it; adding the JS
package does not produce native artifacts or enable the execution backend.

From the repository root, with Xcode, Meson, Ninja, LLVM/LLD, pkg-config and
libarchive installed:

```sh
python3 scripts/ish/prepare_native.py --cache /absolute/path/outside/repository
npx expo run:ios
```

Preparation downloads the pinned iSH source and checksum-verified Alpine rootfs,
builds device and arm64 simulator static libraries, creates an XCFramework, and
copies the complete fakefs seed into ignored `vendor/`. Native dependency changes
require rebuilding the development client. The pod bundles the seed and licenses;
first use clones the entire fakefs tree into app-private Application Support.
Cleanup stops a workspace's commands and preserves its files.

`prepare(workspaceId)`, `execute(workspaceId, commandId, argv, cwd, env,
inputBase64, timeoutMs)`, `cancel(commandId)`, `cleanup(workspaceId)`, and
`commandStatus(commandId)` return promises. `execute` resolves to `{exitCode,
stdout, stderr, omittedBytes, cancelled, timedOut}`; stdout/stderr are base64.
`MooseISHOutput` events contain `{commandId, stream, data}` where data is base64.
Events precede settlement. The caller must register its listener before execute.
Capture is bounded at 16 MiB combined; overflow cancels the command and reports
omitted bytes. Stdin accepts up to 16 MiB and is pumped concurrently with output.
Environment variables are explicit, never inherited from the app.

Admission allows at most four running/queued commands and 32 MiB combined
retained stdin. Capacity rejection uses `spawn_error`, starts no guest command,
and does not record the rejected ID. Retained stdin is released before new
admission after completion. The journal retains at most 10,000 lifetime command
IDs, without eviction; reaching that bound disables new commands while keeping
existing duplicate protection and status queries. Unreadable, malformed or
oversized journals fail closed. Pending cancellation IDs are also bounded at
10,000. These are explicit evaluation limits rather than a journal pruning
policy.

A process-wide coordinator owns workspace storage, journal, jobs and admission
limits across React Native module generations. Reloading the JavaScript bridge
does not reclassify live native commands as interrupted or create a second
journal writer. Invalidating a module cancels its own generation’s jobs, stops
its output events and rejects further commands from that generation.

IDs contain only ASCII letters, digits, `_`, and `-`, up to 128 bytes. The journal
contains IDs, workspace, status and exit code only. Recorded IDs are never
executed twice, including failed/interrupted commands; use a fresh ID for an
intentional rerun. On process restart running records become interrupted. Final
output is returned to the live caller rather than persisted by this module.

Local native verification (build the real host core first):

```sh
python3 scripts/ish/build_embedded.py --cache /absolute/external/cache --sdk macosx --output /tmp/moose-core
python3 modules/moose-ish/tests/run_bridge.py --core /tmp/moose-core
python3 modules/moose-ish/tests/test_package.py
python3 modules/moose-ish/tests/run_bridge_simulator.py --core /tmp/moose-core-simulator --output /tmp/moose-bridge-test
```

The host harness compiles the production Objective-C bridge against Foundation
and the actual embedded library. Its React shim substitutes registration/events,
not the kernel. The separate simulator harness installs a disposable UIKit application under
`dev.moose.ishbridgetest`; remove it with `xcrun simctl uninstall booted
dev.moose.ishbridgetest`. Neither harness establishes physical-device operation.

Generated binaries are for local evaluation. `vendor/source-manifest.json`
records pins and local build-input hashes; it is not complete corresponding
source. Before redistributing any linked app, provide exact whole-app source,
build instructions, all kernel changes, upstream license texts, and rootfs
package licenses/sources, and resolve a compatible whole-program license. See
`docs/ios-ish-execution.md` and `native/ish/NOTICE.md`. Nothing here publishes an
app or waives those obligations.
