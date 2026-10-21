# Termux diagnostics and v0.2.1

Goal: distinguish environment selection from recent connectivity, classify transport failures, and provide a model-free self-test with bounded, private diagnostics.

Design: keep RPC in environment.ts; add a small in-memory diagnostic store and a portable self-test. Each run uses a fresh reserved workspace namespace so an unknown shell outcome cannot block a later diagnostic run; the current service cleanup releases resources but leaves its empty workspace root. Platform owns credentials and serializes setup/self-test; settings subscribes to the store. No new dependencies, automatic retries of tools, background scheduler, persistent logs, or installation monitoring protocol. Existing native callbacks cannot identify download versus deployment; display that uncertainty honestly.

Acceptance: a valid signed response (including ENOENT) establishes reachability; a timeout/network/rejection changes it; task cancellation does not claim the service is offline. Store at most 40 records containing only timestamp, generated correlation number, allowlisted operation/result and elapsed time. Never store request IDs supplied by a model, paths, commands, headers, bodies, keys or raw errors. Recent reachability is explicitly historical, not continuous health monitoring.

Self-test: unique diagnostic workspace, signed connect, write/read fixed text, bash read, remove temporary diagnostic directory, cleanup. Failure and cancellation always attempt cleanup with an independent context. No model calls or changes to conversation files.

## Implementation

- [x] Write transport tests for deadline vs caller cancellation (including abort during response body), native cancellation without caller abort, HTTP rejection, malformed/service errors and normal file errors; observe red, implement typed failures and metadata reporting, verify green.
- [x] Write store tests for bounded history and reachability transitions; implement store with export/subscription and allowlisted data only.
- [x] Write real HTTP/file/bash self-test tests including failure cleanup and workspace isolation; implement portable self-test and platform entry point.
- [x] Wire minimal settings status, self-test/cancel and selectable diagnostics; retain installing phase while bootstrap progress is unknown. Document limits and recovery.
- [ ] Bump app/package to 0.2.1 and Android versionCode to 3. Run full verify/Termux smoke/format/Expo Doctor, independent review, PR, hosted native build and release. User authorized merge/tag/release. Native phone/HyperOS behavior remains a separate user acceptance step; no paid model requests.

Review focus: cancellation precedence, cleanup failures, non-file tool errors not poisoning connection health, credential/content leaks, busy UI and setup/self-test serialization. No emulator installation on this full disk; hosted build does not establish phone execution.
