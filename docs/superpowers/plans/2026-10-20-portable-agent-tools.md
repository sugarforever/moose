# Portable Agent Tools Implementation Plan

**Goal:** Implement issue #3 as scoped native agent tools with replay-safe imports and usable artifacts.
**Architecture:** Portable capability services receive platform adapters. Pi extensions validate tool inputs; services independently enforce enabled skills, user grants, limits and atomic receipts. SQLite databases remain separate from Pi.
**Tech Stack:** TypeScript, Pi Durable 1.3, Expo SQLite/fetch/files, native WebView/share.
**Spec:** docs/portable-agent-tools.md

## Constraints and review focus

No shell/eval/Node runtime; no provider credentials; preserve current files and checkpoints. Validate redirect origins before requests, abort queued and active work, reject malformed mappings and reserved names, prevent cross-skill references, and distinguish committed replay from partial work. Preserve existing user changes.

## Tasks

- [x] Add failing service tests for HTTP/import/query, atomic rollback/reopen/replay, permission boundaries, limits and cancellation. Implement portable HTTP, declarative database/mapping and persisted document/artifact services in src/capabilities/.
- [x] Add failing Harness tests for tool execution and invalid schemas. Register schemas/adapters in src/capabilities/tools.ts and wire engine lifecycle.
- [x] Wire Expo fetch/SQLite, user approval and revocation, offline artifact preview and user-triggered sharing. Extend workspace enumeration and skill resource access.
- [x] Update README and contracts. Run verify, Expo Doctor, formatting and native checks where available; review diff and open PR with precise validation limits.
