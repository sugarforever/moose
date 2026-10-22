# Background diagnostics implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Explain interruptions, show accurate durable task state and recover bounded transient failures after screen lock.
**Architecture:** Extend the existing Harness with a conversation diagnostic document and hooks. Project live state plus committed history into UI; pass persisted native cancellation metadata through the existing execution owner.
**Tech Stack:** TypeScript, Pi Durable 1.3, Expo SQLite, React Native, Android Kotlin.
**Spec:** docs/background-recovery.md

## Global Constraints

- One process-lifetime Harness; no resubmit on foreground return.
- Three model retries, 2/4/8 second backoff, 30 second ceiling.
- Never replay unknown shell/write effects; never persist credentials in diagnostics.
- Controlled model transport only. Preserve the primary checkout's unrelated changes.

## Review Focus

- Historical failures after successful retry must not imply current failure.
- Crash between external side effect and result commit must not repeat mutation.
- Native cancellation metadata must survive process loss and preserve the first cause.
- Switching conversations must not retain another conversation's status.
- Stop during retry must prevent later model calls.

### Task 1: Durable diagnostics and bounded recovery

Files: src/runtime/execution-diagnostics.ts, src/runtime/engine.ts, tests/execution-diagnostics.test.ts.
Produces: executionStatus(view), attempt detail projection, ExecutionDoc, cancellation recording.

- [x] Write regressions for retry/recovery, secret redaction, status projection and unknown operation guard.
- [x] Run them to verify failure, then implement doc/hooks and explicit Pi retry policy.
- [x] Verify with real Harness/SQLite reopen and exact tool/request counts.

### Task 2: Native cancellation reasons

Files: modules/moose-background/android/src/main/java/dev/verysmallwoods/background/{MooseExecutionService,MooseBackgroundModule}.kt, src/platform/{background,runtime-owner}.ts, tests/background-platform.test.ts.
Consumes: engine.stopAll(cause). Produces: persistent native reason/time passed to engine before abort.

- [x] Test native event/recovery propagation before implementation.
- [x] Add first-cause persistence and bridge metadata, preserving normal completion behavior.
- [x] Compile Android; test pending-stop acknowledgement only after successful durable cancellation.

### Task 3: UI and background validation

Files: src/ui/{useMoose,Markdown}.tsx (useMoose.ts), App.tsx, src/dev/BackgroundSmoke.tsx, docs/background-recovery.md.
Consumes: executionStatus and ChatMessage.failure. Produces: current task caption and expandable historical failure details.

- [x] Verify recovered/current/error status projections before wiring UI.
- [x] Add controlled native screen-lock/restart probes; run available matrix cases and record limitations.
- [x] Run npm run verify, native compile, inspect UI and request independent review before delivery. See docs/background-recovery.md for evidence and physical-device limitations.
