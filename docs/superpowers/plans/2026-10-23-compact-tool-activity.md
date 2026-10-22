# Compact tool activity

Goal: replace the waterfall of tool status rows with one expandable summary per user turn.

Design: derive groups from the existing transcript and live projection, without new persistence or scheduling. Keep assistant prose in transcript order and put the summary at the first activity position of each turn. Append live activity to the current turn's group. While active, show the latest running activity (prefer running over queued entries); otherwise show the number of recorded activities, with failure indicated. Do not invent elapsed duration when the transcript does not supply it. Expansion reveals every recorded activity and its existing bounded output. Use a subtle opacity pulse, respect Reduce Motion, and stop animation on completion/unmount. Reset expansion when switching conversations.

Acceptance: multiple tools collapse to one summary, completion updates the same group, user turns remain separate, interleaved assistant prose is retained, live-only states work, failed calls remain discoverable, and input arrays remain untouched. Existing output truncation and credential boundaries remain unchanged. Nested live details have the existing transient lifetime.

Plan:

- [x] Add failing projection tests for grouping, order, latest activity and live transitions.
- [x] Implement pure grouping and summary helpers in src/ui/chat-activity.ts.
- [x] Add ActivityGroup with accessible disclosure and Reduce Motion-aware pulse; wire App.tsx.
- [x] Run tests, typecheck and formatting; attempt actual component preview; document validation limits and open PR.
