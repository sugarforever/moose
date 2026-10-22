# Android composer keyboard repair

Goal: Keep the draft and send control visible above the Android IME, with existing iOS behavior preserved.

Architecture: Enable React Native keyboard avoidance on Android. Keep the composer as a sibling of the shrinking message list. Preserve multiline scrolling, draft state, and keyboard-driven tab visibility. No new dependencies.

- [x] Reproduce on Android emulator and record IME/composer bounds.
- [x] Add a native regression check and observe failure before changing App.tsx.
- [x] Enable Android padding avoidance; verify opening, multiline typing, closing and reopening.
- [ ] Run verify, Expo Doctor, formatting and independent review; create PR, merge and release v0.4.2 after checks pass.

Review focus: edge-to-edge keyboard overlap, extra safe-area spacing, long drafts, repeated keyboard cycles, preserved iOS offset. Native checks send no model requests.
