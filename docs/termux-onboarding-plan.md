# Android Termux onboarding

## Design and acceptance

Replace manual service transfer/public-key copying/startup with a user-initiated Moose setup operation. Keep the two mandatory owner actions: Android RUN_COMMAND grant and one-time allow-external-apps=true in Termux properties. Do not request shared-storage access or weaken app sandbox permissions.

A small local Expo Android module detects Termux and the custom permission, opens relevant app/settings screens, and invokes only a fixed installer via the official RUN_COMMAND service. It serves the service bundled in the APK through a temporary tokenized IPv4-loopback endpoint; the installer checks the SHA-256 pinned by the native module before atomic deployment into Termux private storage. This avoids release-asset availability bootstrapping and large Android intent extras. Node is installed only if missing/too old; installation is explicitly initiated by the user. No private signing seed or provider credential crosses the native bridge, command line, local asset endpoint or Termux. The public key is paired automatically.

The service exposes signed serviceInfo containing its bundled-file SHA-256. Setup succeeds only after both matching version identity and signed workspace probe pass. A running mismatched service is reported explicitly, not killed by an unrelated-PID command. A correct already-running service can be reused. The UI shows installation/connection/error/cancel state and offers settings, Termux launch, one-time configuration command and retry.

Environment switching closes the current engine before opening a replacement, keeping the app alive and reattaching the existing conversation. Block switching while any conversation is running or repeat task is active; do not silently abort jobs. Persist preference only after successful probe; restore the previous preference and runtime on reopening failure. Preserve native stores and Termux files. Scope app permission grants accurately.

Tests: failing controlled onboarding tests before implementation (preconditions, version/connection, timeout/cancel, no credential transfer); actual bootstrap shell deployment/checksum tests; runtime switch ordering/rollback and idle gate tests; existing real HTTP/file/shell suites; bundle/type/portable/full exports/doctor/prebuild. Native compilation and real Termux permission/start/file/cancel require separate evidence. If SDK/device absent, keep draft, attempt hosted Android build and report its actual result. User manual in README and docs must match exact screen labels and state remaining prerequisites.

## Work units

1. Local Android module/config plugin/packaged service asset, fixed bootstrap and callback lifecycle.
2. Portable provisioning controller, serviceInfo and real shell regression tests.
3. Platform signing/storage hookup, UI state/actions, safe live runtime switching.
4. Manual, full checks, independent review, push PR and hosted APK build.
