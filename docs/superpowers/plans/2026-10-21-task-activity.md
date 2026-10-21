# Task activity implementation plan

Goal: show Pi Durable execution progress in the compact chat UI.

Architecture: a pure UI projection reads committed model entries and pi.live. It adds tool result rows to the existing transcript and derives transient status rows without maintaining a second event log or scheduler. No runtime, persistence, provider or dependency changes.

Acceptance: queued/running tools, bounded expandable output, nested tools, retry/deferred generation, thinking and compaction are visible; completed/failed tool results remain in history after reopen; terminal live slots do not duplicate history; switching chats clears transient state. Do not expose thinking content, arguments or raw diagnostics automatically.

- [x] Add regression tests for transcript ordering, tool errors, duplicate suppression, nested tools, idle/terminal states, retry and compaction, output bounds.
- [x] Implement src/ui/chat-activity.ts and compact expandable ActivityRow; connect useMoose and App.
- [x] Run full tests, typecheck, portable smoke and platform exports; inspect native UI if available, document limitations.
- [x] Review branch, commit, push and open PR.
