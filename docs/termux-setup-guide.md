# Moose Android Termux Phone Setup Guide

This guide covers the automatic setup version in PR #8. Install a new APK containing the `MooseTermux` native module; refreshing JavaScript cannot add it to an older APK. Android physical-device acceptance remains pending. These steps describe the implementation, not a completed device test record.

## 1. Prerequisites

- An Android phone with Termux installed and initialized.
- A Moose APK containing this change. Rebuild development clients; Expo Go is unsupported.
- Network access to Termux package repositories.
- To test model calls, configure model credentials in Moose. Do not copy API keys or OAuth tokens into Termux.

No computer file transfer, service file download, manual Node installation in Termux, pairing public-key copying, or shared-storage permission is required.

## 2. Initial manual steps

1. **Open Termux once.** Wait for initialization until a command prompt appears.
2. **Open Moose Settings.** Find “Execution environment.” It should offer “Open Termux” and “Set up and connect Termux.” If the automatic setup module is missing, install the new APK; restarting an older APK cannot add a native module.
3. **Grant command permission.** Tap “Allow running commands” to allow Moose to run commands in Termux. If no prompt appears or permission was denied, tap “Open system settings,” open Moose's “Permissions” or “Other permissions / Additional permissions,” and enable permission to run commands in Termux. System labels vary by phone.
4. **Copy the one-time command.** Return to Moose, long-press the displayed setup command, and copy it. You can copy this entire line:

```sh
mkdir -p ~/.termux && printf '\nallow-external-apps = true\n' >> ~/.termux/termux.properties && termux-reload-settings
```

5. **Run the one-time command.** Tap “Open Termux,” long-press the terminal to paste, and press Enter. Once the prompt returns without errors, switch back to Moose. The command only creates the configuration directory and appends the setting allowing external app calls; it downloads no service and writes no model credentials.
6. **Start automatic setup.** Tap “Set up and connect Termux.” Keep Moose in the foreground while it shows states such as “Checking Termux and service versions,” “Installing dependencies and deploying service, please wait,” and “Connecting to Termux service.” Installation is skipped if a compatible service exists. First installation may take a few minutes to download Node or locking tools from Termux repositories.
7. **Confirm success.** Once “Connected to Termux.” appears and the current environment reads “Termux,” it is ready without closing or restarting Moose. If it fails, check the guidance below and retry with the same button.

The system RUN_COMMAND permission and Termux's `allow-external-apps` setting are separate authorizations. Automatic deployment requires both. [Official Termux setup requirements](https://github.com/termux/termux-app/wiki/RUN_COMMAND-Intent#setup-instructions)

## 3. Test functionality

Create a new conversation and test each of these:

1. Send: “Write hello to hello.txt in the current workspace, then use bash to run cat hello.txt.” Confirm the answer includes the actual read result.
2. Send: “Use bash to change hello.txt to hello termux, then read it with read.” Confirm file tools and the shell see the same content.
3. Send: “Use bash to run sleep 30, then output finished.” Tap Moose's stop button during execution. Confirm the response stops and subsequent requests still work.
4. Switch to another new conversation and request hello.txt. Confirm that the new conversation does not contain the file.

These tests use the current model and may incur model charges. A model's claim of success is insufficient evidence; inspect the corresponding tool results. Preserve error text when failures occur, and avoid repeatedly running commands that may have external side effects.

## 4. Everyday operations

- **Reconnect:** After a phone restart or Termux service exit, open Moose → Settings → “Check or repair connection.”
- **Return to local files:** Tap “Use local files” and wait for confirmation. No restart is needed; Termux files are not copied automatically.
- **Switch blocked:** Wait for all conversations to finish, resolve pending submissions, and stop active recurring tasks on the Tasks page, then retry. Switching does not automatically terminate them.
- **Cancel setup waiting:** Tap “Cancel setup.” Temporary transfers and waits stop, but installed dependencies remain and installation processes whose downloads finished may continue. You can check or repair the connection later.
- **Background execution:** Continued execution after locking the screen is not guaranteed. You may adjust Termux and Moose battery policies in Android settings if power restrictions interfere; this still does not guarantee persistent execution.

## 5. Common errors

| Symptom                                          | Manual action                                                                                                                                                                                        |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Termux not found                                 | Install and open Termux once, then return to Moose                                                                                                                                                   |
| Automatic setup native module missing            | Install the new APK for this PR; refreshing the screen is insufficient                                                                                                                               |
| RUN_COMMAND permission failure                   | Allow running commands in Termux in Moose's system app permissions                                                                                                                                   |
| Prompt to check allow-external-apps              | Rerun this guide's one-time configuration command in Termux, then retry                                                                                                                              |
| Node or locking tool installation fails          | Open Termux and check connectivity and package repositories; run `pkg update` to inspect repository messages, resolve them, and retry in Moose                                                       |
| Incompatible service version or pairing mismatch | If you manually ran `node ...service.mjs` using the old guide, press Ctrl+C in that Termux session to stop the old Moose service, then retry; do not arbitrarily kill other processes or delete data |
| Unconfirmed command result                       | Inspect files and external operations already produced, then follow [Recovery guidance](termux.md#recovery-and-limits); do not resubmit immediately                                                  |
| Repair still fails after the service stops       | Preserve the full error text. Do not delete `.requests` receipts, databases, or workspaces to bypass the error                                                                                       |

## 6. What Moose does automatically

Moose checks installation and permission state, runs a fixed installer through Termux's official RUN_COMMAND interface, and installs Node and the `flock` locking tool as needed. Service code comes from the current APK, is transferred through a temporary loopback port and checked against SHA-256, then deployed to Termux's private directory, paired with a public key, and started. Connection checks the running service version and signed requests before switching runtimes; if switching fails, it attempts to restore the previous environment.

The model cannot invoke this installer or obtain Moose's private signing seed or model credentials. Termux receives only the pairing public key. Files and commands still run within the Termux app's permissions; this is not a security container. Native tools' per-domain authorization does not constrain the shell.

## Acceptance record

Record the new APK version, phone Android version, Termux version, and whether initial authorization, automatic installation, file/shell operations, stopping, repair after restart, and switching back to local files succeed. Record physical-device results separately from automated protocol tests and APK build results; they do not replace one another.

## v0.2.1 diagnostics

The execution environment shows the current selection and the latest communication result and time from this app launch. This is not continuous health monitoring. Tap “Run self-check (no model calls)” to verify the signed connection, temporary file read/write, and bash. Temporary files use a reserved diagnostic workspace separate from chat workspaces, with cleanup attempted afterward. Cleanup may fail if the connection drops; rerun the check after reconnecting. Chat tools are not automatically replayed.

“View diagnostic records” retains only the latest 40 metadata entries from this launch, selectable by long-press for copying. Records contain no paths, commands, bodies, signatures, or credentials. A missing file does not imply disconnection; request timeout, task cancellation, and transport interruption of unknown origin are reported separately. Diagnostics do not infer background restrictions or user stops from generic fetch errors.

Physical-device acceptance: connect and run the self-check in the foreground, copying records on failure. Then separately switch between foreground/background and lock/unlock the screen, rerun self-checks, and compare times and error categories. No real model calls are required. Without a connection, use “Check or repair connection” or switch to local files.
