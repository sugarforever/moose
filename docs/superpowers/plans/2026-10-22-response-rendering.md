# Response Rendering Implementation Plan

**Goal:** Render Markdown assistant responses using native components.
**Architecture:** markdown-it produces a small tree consumed by a native renderer; App uses it for both completed and streaming assistant messages.
**Tech Stack:** React Native, TypeScript, markdown-it, Vitest.
**Spec:** docs/response-rendering.md

## Constraints and review focus

Preserve user literals and text selection. No HTML execution or automatic image requests. Test unsafe URLs, incomplete streams, nested lists, wide tables and Unicode.

- [ ] Add failing tests in tests/markdown.test.ts for parseMarkdown and safeMarkdownUrl.
- [ ] Implement src/ui/markdown.ts tree normalization and URL policy, run tests.
- [ ] Implement src/ui/Markdown.tsx native layout; use in App.tsx.
- [ ] Run npm run verify, formatting and Expo Doctor; review and create PR.
- [ ] Merge only after PR checks pass.
