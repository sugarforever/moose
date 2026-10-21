# Android Release Updates Implementation Plan

**Goal:** Discover GitHub APK releases, download and verify an update, and open Android's installation confirmation.

**Architecture:** A portable update controller owns throttling and cancellation. An Expo adapter downloads files; a local Android module verifies APK identity and invokes the installer. CI publishes a versioned manifest beside the APK.

**Spec:** docs/android-updates.md

## Constraints and review focus

- Preserve existing workspace changes and current signing identity.
- Never embed GitHub credentials or update through a different repository.
- Check prereleases, malformed manifests, API throttling, cancellation races, and permission denial.
- iOS must continue to export without requiring the Android module.

## Tasks

- [x] Write controller tests with controlled transport and storage for release discovery, validation, throttling, cancellation, and install permission handling; run and observe failures.
- [x] Implement src/updates/controller.ts with injected transport/platform interfaces and immutable observable state; make controller tests pass.
- [x] Add modules/moose-updates Android module and src/platform/updates.ts for streamed hashing, package/signature checks, cancellable cache downloads, and system intents.
- [x] Add src/ui/updates.tsx and integrate the app-scoped controller into App.tsx and settings; show a compact update entry and explicit install action.
- [x] Add app.config.js and scripts/android-release.mjs, update GitHub Actions to publish a manifest and monotonic versionCode; test the script against a temporary APK.
- [x] Run formatting, full tests, type checking, Expo configuration/autolinking checks, doctor and release resource export; document actual native validation limits.

Implementation is isolated from existing uncommitted Codemode changes in a managed worktree. The user requested a pull request; no release or merge is requested.
