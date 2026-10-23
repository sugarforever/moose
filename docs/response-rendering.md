# Response rendering

Assistant responses, including partial streaming responses, use native Markdown blocks. User messages remain literal. Support headings, emphasis, lists, quotes, code and tables, preserving selectable text and horizontal scrolling for wide code/tables. HTML stays literal; images show alt text without network loading. Only HTTP(S) links open after a tap. No WebView or script execution.

Acceptance: parser regression tests cover incomplete fences, nested lists, tables, literal HTML and unsafe links; run the full verification pipeline and PR checks. Native visual verification is reported separately.

Validation: 181 tests passed, 8 skipped; all 3 installer tests, TypeScript, portable smoke and both Hermes exports passed. Independent review found no actionable issues. Expo Doctor: 18/20, existing native metadata warnings and Expo patch mismatches. Native visual/interaction verification remains pending; no real model requests were made.
