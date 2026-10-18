# Moose Mobile Implementation Plan

**Goal:** A local Android/iOS chat app powered by real Pi Durable, with recoverable tasks, instruction-only URL skills, and secure credentials.

**Architecture:** Expo SQLite implements Pi Durable's portable SqliteDatabase contract. A prebundled portable runtime avoids Node adapters and Metro's variable dynamic import limitations. Native fetch handles model streams; SecureStore owns keys/tokens. The app runs locally and resumes committed tasks on foreground launch.

**Tech Stack:** Expo 58, React Native, TypeScript, Pi Durable/AI/Chord 1.3.0, Expo SQLite, SecureStore, AuthSession.

## Constraints

- No shell, subprocesses, downloaded JavaScript, or skill script execution.
- Background execution is best effort; overdue repeats run once when foregrounded, never an unbounded catch-up burst.
- ChatGPT login uses an explicit supported public-client flow; no Node callback server or reused CLI secret. Claude subscription login is unavailable; support its API key.
- Keep secrets outside transcripts and ordinary settings. No paid requests during automated tests.

## Review Focus

- Interrupted admission and retry must preserve request identity.
- SQL transactions must isolate concurrent readers/writers and roll back before rejecting.
- Remote skills must be bounded text, support GitHub URLs, and never execute assets.
- Repeat tasks must survive reopen without duplicate scheduled submissions.
- OAuth cancellation, state mismatch, token rotation, and API errors must be visible without disclosing secrets.

## Deliverables

- [x] Portable runtime dependency audit and browser bundle smoke check.
- [x] Test SQL rollback/serialization and real Harness reopen/checkpoint recovery before implementation.
- [x] Test URL normalization, bounded skill install, and prompt selection before implementation.
- [x] Test durable repeat workflow, duplicate retry, and checkpoint branching before implementation.
- [x] Implement Expo native persistence, credential UI, chat/task/skill screens, and lifecycle recovery.
- [ ] Implement mobile ChatGPT auth: blocked on a native HTTP loopback callback adapter and real-account validation. Official flow and prerequisites documented; unavailable status shown in-app.
- [x] Run tests, TypeScript, platform export and native build availability checks; document verified scope.
