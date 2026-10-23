# Moose iOS iSH Setup Guide

This guide covers the optional embedded iSH backend in PR #7. It follows the Android [Termux phone setup guide](termux-setup-guide.md), but iSH runs inside Moose: there is no separate terminal app, companion service, pairing key or phone-side command-execution permission to configure.

A developer must prepare the native dependency and build a client that includes it. Refreshing JavaScript cannot add iSH to an older client. Simulator operation has been verified; physical-iPhone signing, installation and background behavior remain unvalidated. These instructions are not a physical-device acceptance record.

## 1. Prerequisites

- An Apple Silicon Mac with full Xcode installed and opened to complete its initial setup.
- An installed iOS simulator runtime, or a connected iPhone with Xcode development signing/provisioning configured for your Apple account.
- Node.js 22.19 or later, Git and Homebrew on the Mac.
- Network access on the Mac to download the pinned iSH source and Alpine root filesystem, plus npm/build dependencies.
- A checkout containing PR #7. The default main-branch client may not include this experimental backend.
- For conversational tests only, a model connection configured in Moose. Keep API keys and OAuth tokens in Moose Settings; never copy them to guest files or shell variables.

The iPhone does not need the standalone iSH app, Termux, Node.js, a manually imported root filesystem or shared-storage access. The local guest does not require a network port or pairing.

## 2. Initial manual steps

### Prepare the Mac

1. **Check Xcode.** Run `xcode-select -p`. It must select full Xcode, rather than only Command Line Tools. If needed, select your installation, for example:

   ```sh
   sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
   ```

   Open Xcode to finish installation and install an iOS simulator runtime in Settings. Confirm the SDK is available:

   ```sh
   xcodebuild -version
   xcrun --sdk iphonesimulator --show-sdk-path
   ```

2. **Install native build tools.** Run these commands on the Mac:

   ```sh
   brew install python meson ninja llvm lld libarchive pkgconf
   export PATH="$(brew --prefix lld)/bin:$PATH"
   export PKG_CONFIG_PATH="$(brew --prefix libarchive)/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
   ```

   Keep the exports in the terminal used for preparation. LLD is a separate prerequisite; the script does not install missing tools.

3. **Prepare iSH from the repository root.**

   ```sh
   npm ci
   npm run prepare:ish
   ```

   Keep network access available for initial downloads. Preparation verifies the pinned source/rootfs, builds device and arm64 simulator static libraries, and writes local artifacts under `modules/moose-ish/vendor/`. These files are ignored by Git. The default build cache is `/tmp/moose-ish-embedded`.

### Install and start Moose

4. **Build the simulator client with iSH enabled.**

   ```sh
   EXPO_PUBLIC_MOOSE_ISH=1 npm run ios
   ```

   This compiles/installs the native client and starts Metro. Expo Go is unsupported. An older development client needs rebuilding even if it can load newer JavaScript.

5. **For an iPhone, complete development signing first.** Connect the phone to the Mac and use:

   ```sh
   EXPO_PUBLIC_MOOSE_ISH=1 npm run ios -- --device
   ```

   Complete Xcode's device trust, signing-team and provisioning requirements for your account, and enable Developer Mode if requested by iOS. These device steps have not been validated by this PR. The repository does not currently publish an iSH-enabled IPA or TestFlight build.

6. **Configure the model in Moose Settings.** Select the provider, configure its credentials and save. Start a new conversation. iSH is selected by the JavaScript build flag; there is no iOS “Set up and connect” button or execution-environment switch in Settings. `/workspace` initializes automatically on first file or shell use.

## 3. Test functionality

### Controlled developer smoke, without a model account

Stop your existing Metro process before changing flags, then run:

```sh
EXPO_PUBLIC_MOOSE_ISH=1 EXPO_PUBLIC_MOOSE_FILES_SMOKE=1 npm run ios
```

The app opens a dedicated test screen instead of normal chat. Success displays **Moose filesystem smoke passed**, with checks for controlled SSE → Pi write/edit/bash/read, file/SQLite reopen, transcript persistence, checkpoint workspace isolation and traversal rejection. The test uses isolated smoke storage and controlled model responses; it does not use real model credentials or send billable requests.

To return to normal chat, stop this Metro process and run `EXPO_PUBLIC_MOOSE_ISH=1 npm start`, omitting `EXPO_PUBLIC_MOOSE_FILES_SMOKE`, then reopen/reload the client. Run `npm run test:ish` on the prepared Mac for the separate native core/bridge and Pi adapter tests; it is not an in-app self-check.

### Conversational checks

These checks use your selected model and may incur charges. Inspect actual tool results rather than accepting a model's statement of success.

1. Ask: “Write hello to hello.txt in this workspace, then run cat hello.txt with bash.” Confirm that the shell reads the file written by the file tool.
2. Ask: “Use bash to change hello.txt to hello ish, then read it with read.” Confirm both tools see the same content.
3. Ask: “Use bash to run sleep 30, then print finished.” Tap Stop during execution; confirm the run stops and a later request still works.
4. Open a separate new conversation and try to read hello.txt. Confirm that its workspace does not contain the file.
5. After the original run has completed, reopen Moose and read hello.txt in the original conversation. Record whether its contents persist.

Do not automatically resubmit a command after an interrupted or unknown result. Check already-produced files first. Checkpoints preserve conversation history, not filesystem snapshots; a checkpoint branch starts with a separate root.

## 4. Everyday operations

- **Start development again:** Run `EXPO_PUBLIC_MOOSE_ISH=1 npm start` and press `i` for the simulator. Keep the same flag on every Metro start/export that should select iSH. The flag is bundled JavaScript configuration, not an environment variable entered on the iPhone.
- **Return to default files:** Finish or stop active responses, pending submissions and recurring tasks, stop Metro, and restart without the iSH flag. Reload the client. Files are not copied between Expo and iSH; switching does not delete either backend's files.
- **Rebuild after native changes:** Rerun preparation when the embedded core changes, then rebuild the native development client. Fast Refresh cannot update linked libraries or bundled rootfs resources.
- **After an app/process restart:** Files persist; killed guest processes cannot resume their CPU state. The command journal prevents reusing recorded IDs, and unfinished records become interrupted after process restart. Use the app's run status and tool errors to decide what needs checking before deliberately rerunning.
- **Foreground/background:** Keep Moose visible for execution that matters. iOS suspension can pause the app. Do not assume Android's foreground-service behavior applies to iOS; locked-screen execution is not guaranteed.

The runtime flag does not control native package inclusion. Once prepared artifacts exist, native autolinking can include iSH and its rootfs even when the flag is off. An unprepared clean checkout omits that optional module. Do not treat disabling the flag as removing native code or resolving distribution obligations.

## 5. Common errors

| Symptom                                                              | Manual action                                                                                                                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iSH native module is missing`                                       | Run `prepare:ish`, rebuild the native client, and reopen that client rather than Expo Go or an older installation.                                                                                |
| Missing `meson`, `ninja`, `pkg-config` or LLD                        | Install the prerequisites and restore the PATH/pkg-config exports in the current Mac terminal.                                                                                                    |
| Xcode/SDK not found                                                  | Select full Xcode, finish its initial setup and install the required simulator runtime.                                                                                                           |
| Source/rootfs download or checksum failure                           | Check Mac connectivity and preserve the exact error. Retry preparation; do not disable checksum checks.                                                                                           |
| Signing/provisioning failure on an iPhone                            | Resolve device/team/provisioning configuration in Xcode; simulator success does not verify device signing.                                                                                        |
| App uses default files or has no bash tool                           | Restart Metro with `EXPO_PUBLIC_MOOSE_ISH=1` and reload the rebuilt client. Confirm that you are using the intended server/client.                                                                |
| Test screen appears instead of chat                                  | Restart Metro without `EXPO_PUBLIC_MOOSE_FILES_SMOKE`, retaining the iSH flag for normal iSH chat.                                                                                                |
| `apk`, `curl` or a Skill cannot reach the network                    | Guest networking is disabled. Approved Moose native HTTP tools are separate; the terminal is not a network-enabled Termux replacement.                                                            |
| A Skill script/interpreter is unavailable                            | Installing a Skill does not install its runtime dependencies. Only bundled guest programs and supported syscalls are available; the shell is POSIX `/bin/sh`, not full Bash.                      |
| Timeout, cancellation, output/file limit or execution capacity error | Preserve the exact error and check any output/files already produced. Narrow the command or wait for active work to finish before deliberately retrying. See exact limits in the execution notes. |
| Journal unreadable or lifetime command capacity exhausted            | Preserve the error and workspace data for diagnosis. Do not delete the journal or alter command IDs to bypass replay protection; there is no supported automatic pruning/reset flow.              |

## 6. What Moose does automatically

The native build embeds the pinned iSH CPU/syscall core and verified Alpine rootfs. First use copies the full fakefs seed into an app-private conversation root. File tools and shell commands operate through the same core, with explicit argv/environment and stdin/stdout/stderr. There is no companion-service installation, public-key exchange or external terminal launch.

The native coordinator serializes guest execution, bounds admission/output/resources, cancels command-domain descendants and retains a persistent command-ID journal. The Pi bash wrapper records durable intent before effects and does not automatically replay unsafe commands. Guest networking and host filesystem mounts are disabled. Model credentials remain in Moose secure storage and are not inherited by the guest.

The interpreter shares the Moose OS process; it is not a separately sandboxed VM. See [execution and licensing notes](ios-ish-execution.md) for the exact source pin, resource bounds and corresponding-source obligations before distributing any linked binary, even with the runtime flag disabled.

## Acceptance record

Record the Moose version/commit, Mac architecture, Xcode and iOS versions, simulator/device model, preparation result, native build/signing result and enabled flags. Then record file/shell interoperability, Stop, separate conversations, checkpoint branches, file persistence after restart and return to the default backend.

Record host tests, Hermes exports, simulator operations, physical-device operations and real model requests separately. For a physical device, separately test foreground use, switching apps, lock/unlock and reopening, preserving status and errors without assuming uninterrupted background progress. No completed physical-device acceptance is claimed by this guide.

## Diagnostics

There is currently no iOS equivalent of Termux's **Run self-check (no model calls)** or **View diagnostic records** settings buttons. Use the controlled developer smoke and native verification commands above. Preserve displayed errors and tool results; do not include API keys, OAuth tokens or private file contents when sharing a report.
