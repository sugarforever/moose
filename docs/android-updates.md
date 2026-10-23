# Android Release Updates

## Design and acceptance

The app checks the GitHub Releases list in the public sugarforever/moose repository, including prereleases currently in use. No GitHub token or app backend is required. Automatic checks run on launch and return to the foreground, at least six hours apart. Manual checks bypass this interval but still respect rate-limit backoff. Network failures must not block chat.

Each release that supports updates includes moose-update.json with the APK filename, version, increasing versionCode, size, and SHA-256. The app accepts only HTTPS URLs for release assets in this repository. Older releases without a manifest are skipped. Version comparisons use versionCode.

Settings shows the current version, check results, release notes, download progress, cancellation, and errors. An available update only exposes an entry point; it does not download automatically or interrupt tasks. Downloads use a separate cache directory, with files cleaned up on cancellation, failure, and redownload. After downloading, verify SHA-256 by streaming and check that the package name, versionCode, and signature are compatible with the current app before opening the system installer. If installation permission is missing, open this app's system permission page; the user clicks install again on return. Opening the installer must not be treated as successful installation.

A local Android Expo module provides version queries, APK verification, installation permission, and installer invocation. It is excluded from the Pi runtime bundle. iOS neither loads this module nor shows the update entry point. OTA, Play, and iOS updates are outside this change.

CI sets the version name for tag builds and uses github.run_number as an increasing versionCode, then generates and publishes the manifest. Manual builds upload the APK and manifest without publishing a release. Signing continues to use the existing test signature; production key migration remains unresolved. Plan migration of device-local data separately before changing signatures.

When migrating or recreating workflows, ensure versionCode exceeds every published version; do not restart numbering at one. Each check reads at most 20 releases and chooses the highest build number among their valid manifests.

Acceptance covers controlled Releases/manifest responses, filtering older versions, prereleases, malicious URLs, verification failures, rate limits, concurrency, cancellation, and installation permission flows. Complete checks include tests, type checking, and release asset exports for both platforms. Report Android native compilation and in-place upgrades on a physical device separately; portable tests and asset exports cannot replace them.

## Initial implementation validation

- `npm run verify` passed on an isolated branch, including 65 tests, TypeScript, real Pi portable execution, and Android/iOS Hermes release asset exports.
- The updater and release manifests have 24 controlled tests covering rate-limit backoff persistence across restarts, late results during cancellation, cancellation while waiting for installation permission, redownload after cache loss, and manifest/package digest generation.
- Expo Android autolinking recognizes the local `moose-updates` module. `npx expo-doctor` scored 19/20: existing `react-native-tcp-socket` metadata marks the New Architecture as untested, and the local module has no React Native Directory metadata.
- This machine has only Android platform-tools, without the complete SDK. Android native compilation, simulator operation, and physical-device installation were not performed. Asset exports are not APKs. No iOS native build or real model requests were run.
- The existing test signature is unchanged; production signing migration still needs a separate design. Older apps require one manual installation of a version containing this feature.

## Main-branch merge and English conversion

PR #13 incorporates the current main branch. The release command retains all three assets: the APK, `moose-update.json`, and the Termux companion `service.mjs`.

App-owned labels, errors, accessibility text, comments, and project documentation use English. UI date/time formatting uses `en-GB`. Existing user content and deliberate Unicode test fixtures keep their original text.

The merged branch passed `npm run verify`: 164 tests passed and eight unsupported upstream watch cases were skipped, three Termux bootstrap tests passed, TypeScript and portable runtime checks passed, and Android/iOS Hermes release assets were exported. Formatting and conflict-marker checks passed. Independent code and documentation reviews found no important issues. Expo Doctor remains at 19/20, reporting the existing TCP New Architecture warning and missing directory metadata for the local update and Termux modules. No native application compilation, device installation, or real model requests were performed during this follow-up.
