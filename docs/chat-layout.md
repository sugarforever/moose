# Compact chat UI

Use single-row navigation, compact user bubbles, and answers without card borders. Remove repeated role names, branding rows, persistent rerun controls, and the separate conversation information bar. Keep history and new conversation actions in navigation; move checkpoints into the more menu and use the model name as a compact subtitle.

Long-press message text for native selection and Copy. User messages expose a separate Message options button for resend, so the resend menu cannot intercept text selection. The button acts on that message and is unavailable during execution or without a connected model. It remains accessible by its button label. UI validation must not actually send user messages. Markdown text is selected within its native blocks (paragraphs, headings, list items, code blocks and table cells), rather than across separate blocks. Keep list clipping disabled so Android does not detach selectable text while scrolling.

The composer uses system keyboard avoidance. Hide the bottom tab bar and remove extra bottom safe-area spacing while the keyboard is open; restore them when it closes. Tap targets must be at least 44 points, and text must support system font sizes. Follow new content only when the user is at the bottom of the list, so reading is not interrupted.

Phones support portrait and both landscape orientations, subject to the system orientation lock. Preserve the flexible layout and dynamic safe-area insets, including horizontal insets in landscape. The conversation history modal explicitly allows portrait and landscape. Rotation must retain the selected conversation and unsent draft. Regenerate and reinstall the native client after changing orientation configuration.

The composer is a compact horizontal row: a scrollable multiline draft and a fixed 44-point send/stop target. Reserve the composer and tabs in normal layout; let the message list yield the remaining space rather than shrinking the panel around overflowing children. The draft has a 44-point minimum, a 120-point portrait maximum and a 72-point landscape maximum. Android fullscreen input extraction is disabled so landscape editing retains the chat and send control. Model identity stays in the navigation subtitle.

Rotation validation on 2026-10-22: an iPhone 17 Pro simulator reproduced an eight-line draft hiding Send behind the landscape keyboard before the shrink fix. Afterward, both landscape directions and returning to portrait kept the draft and Send visible, and opening, rotating, and closing the history sheet worked. The landscape Settings page kept its content scrollable above the tabs. The unsigned Debug build reported a SecureStore entitlement error on startup; it was dismissed for layout checks, so existing-account and saved-conversation restoration were not validated. No sign-in or real model requests were performed. Android native rotation and physical phones remain untested; generated Android configuration and both platforms' Hermes release assets were checked separately.

References: [Apple Context menus](https://developer.apple.com/design/human-interface-guidelines/context-menus), [Apple Layout](https://developer.apple.com/design/human-interface-guidelines/layout). Acceptance: inspect existing message layout, the long-press menu, and keyboard opening/closing in the simulator without real model requests; run type checking and existing tests.

Validation for this iteration: type checking and all 34 existing tests passed. The iPhone 17 Pro simulator was used to inspect an existing multi-turn conversation, the native message action menu, and the expanded keyboard layout. Menu validation used the accessibility “Message options” action, which invokes the same handler as long-press, and selected cancel without resending. iOS KeyboardAvoidingView needs the top safe-area offset to keep the composer above the keyboard. Android device validation was not performed in this iteration.

Development builds hide Expo's floating tools button by default so it does not cover the close action at the top right of the conversation history sheet. The development menu remains available through simulator shortcuts or the shake gesture. The overlap was reproduced in the existing iPhone 17 Pro simulator; after hiding the button, opening and closing history and returning to chat were verified. Type checking passed; no model requests were sent.

## Execution activity

The chat projects committed tool results and pi.live into compact status rows. Queued/running tools (including nested tools), model retry/deferred responses, thinking, and context compaction have short labels. Thinking content, tool arguments and raw diagnostics are not displayed. Text tool output is collapsed by default and limited to its last 4,000 characters with a truncation marker; it is selectable when expanded. Existing assistant text remains plain text.

Tool results stay at their transcript entry positions after completion or reopening, including failed calls. Live slots that already have a committed result are omitted to prevent duplicate rows. Transient state is cleared when changing conversations; the existing disposed watcher guard rejects late updates. No new event log, persistence format, provider behavior or scheduler is introduced. Nested progress is transient; durable top-level tool results supply the history.

Validation on 2026-10-21: projection regressions plus real Harness/file-tool/SQLite reopen coverage; browser preview of the actual ActivityRow component confirmed collapsed output, expansion and error output. Native compilation and simulator/device interactions were not performed for this change. No real model requests or account authorization were used. Full command results are recorded in the PR.

## Android composer, v0.4.2

The composer follows the supplied Codex mobile reference: a white rounded panel with a full-width multiline draft above a separate row for model identity and the send/stop control. It remains in normal layout below the message list and above the keyboard. The existing 44-point controls and 140-point scrollable draft limit remain. Do not add attachment or permission controls before those features exist.

Android now explicitly uses KeyboardAvoidingView padding, as iOS already does. Relying only on window resizing left the composer behind the IME on the edge-to-edge Android layout. Keep the top safe-area coordinate offset; hide tabs and omit the bottom safe-area inset while typing.

References: [React Native KeyboardAvoidingView](https://reactnative.dev/docs/keyboardavoidingview), [Android keyboard insets](https://developer.android.com/develop/ui/views/layout/sw-keyboard), [Telegram multiline input](https://telegram.org/blog/welcome-messages-buttons-TG-13). The supplied Codex screenshot is the visual source; Telegram also keeps long-form editing in the message composer.

Regression: open a chat and its software keyboard, then run `python3 scripts/check-android-composer.py emulator-5554`. This inspects the actual IME top and accessibility bounds, asserting both draft and send button are visible above the keyboard and tabs are hidden. It failed before the fix (draft bottom 2376, IME top 1499) and passed afterward. No messages are sent. Also inspect long drafts, keyboard dismissal, and reopening manually.

Expo Doctor excludes the three repository-owned native modules from public-directory metadata checks because that directory does not catalog local modules. It excludes react-native-tcp-socket's existing new-architecture metadata warning; the dependency is unchanged, and native build/protocol validation remains necessary. These exclusions do not suppress SDK version checks. The SDK patch mismatches found during this change were corrected.

## Android compact composer and selection verification, 2026-10-22

Based on main commit 1656932888cbfd61030585111c28b95e5068de85. Before the change, the native bounds check reproduced Send bottom 888 overlapping tabs top 823 in a constrained landscape viewport; an empty composer also failed the compact-row check. Long-pressing the user sample opened Resend instead of native selection.

A freshly generated Android Debug client compiled and installed on the Android 35 arm64 emulator (1080 × 2400, 420 dpi). Normal portrait and both native landscape rotations were checked with the keyboard shown/hidden and an eight-line draft. The draft survived rotation; its contents remained scrollable and the complete 44-point Send target stayed above the IME or tabs. Representative landscape keyboard bounds: draft [253,276,2029,465], Send [2039,350,2154,466], IME top 496. Portrait keyboard bounds with the long draft: draft [47,1153,907,1468], Send [918,1353,1034,1469], IME top 1499.

Temporary local user/assistant samples exercised the actual message renderer while blocking sends. Native user selection showed handles and the Copy toolbar, and copied text was pasted into the draft. The same clipboard round trip passed for bold Markdown paragraph text, fenced code and a table cell. Temporary samples were removed from the delivered source. No real model requests or account authorization were performed. iOS and physical devices were not exercised in this iteration.

Run `python3 scripts/check-android-composer.py emulator-5554` with the keyboard open, or add `--closed` with tabs visible. Add `--empty` for an empty draft to check the compact row. These checks inspect native bounds; they do not send messages.

Final source checks: 27 Vitest files passed (206 tests passed, 8 skipped), TypeScript and Prettier passed, and iOS/Android Hermes release assets exported successfully. The clean production source launched in the Android Debug client and passed the empty portrait composer bounds check after removing the samples. No iOS native compilation or device run was performed.
