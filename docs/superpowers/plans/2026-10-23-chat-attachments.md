# Conversation attachments implementation plan

**Goal:** Let a user select files, choose photos, or take a photo during a conversation, then preview, remove, and send them with optional text.

**Architecture:** Native Expo adapters capture bytes; conversation-scoped drafts prevent late picker results crossing chats. The existing SQLite outbox persists stable requests. Pi custom input entries retain attachment metadata and bytes; images use image content blocks and ordinary files enter the conversation workspace. Preserve current main's execution leases, background behavior, message selection, and activity presentation.

**Spec:** [Attachment design and validation](../../chat-attachments.md).

## Constraints

- Four attachments per message; original and converted files at most 8 MiB each.
- Normalize photos to JPEG, maximum edge 2048 pixels; request camera access only when used and do not request microphone access.
- Preserve attachments on retry, explicit resend, history reopen, and checkpoint branches. Retrying a committed request must not overwrite later edits.
- Reject unsupported image models, unsafe names, and invalid data. Keep provider credentials isolated.
- Selection cancellation is silent. Permission failures are visible. Cleanup app-owned temporary copies on success and failure.
- Unsent drafts remain in memory; restart recovery applies to outbox and committed history.
- Preserve unrelated working-checkout changes; create the PR against current main with only this feature.

## Tasks

- [x] Add validation and Pi input mapping tests before implementation.
- [x] Add real Harness / SQLite tests for attachment-only submission, retry, history, duplicate filenames, workspace import, and checkpoint restoration.
- [x] Add picker cancellation, permission, size/count, format normalization, and temporary-resource tests.
- [x] Add conversation-scoped draft tests, native picker adapters, and UI previews/removal.
- [x] Verify image requests through controlled OpenAI, Anthropic, and Codex transports.
- [x] Review implementation independently and fix cache cleanup findings.
- [x] Port onto latest main while retaining its execution ownership and UI behavior.
- [x] Complete PR-branch verification and record actual results before publishing.

Physical-device capture and Android native validation remain explicit follow-up checks when hardware is available. Prior simulator results apply to the original implementation build, not automatically to the migrated PR build.
