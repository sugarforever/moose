# Portable agent tools

Implements GitHub issue #3. Agent tools are registered in a Pi Durable extension; portable services receive native fetch, separate SQLite databases, workspace and user-approval adapters. No shell, eval, or Node adapter enters the mobile bundle.

## Trust and persistence

Tools are registered with the Moose agent independently of Skills. Omit `skillId` to use persistent conversation-private storage and conversation-scoped grants; no Skill installation or selection is required. Supplying `skillId` explicitly selects that installed, enabled Skill's shared namespace, validated on every invocation. Only `skill_resource_read` always requires `skillId`. Skill instructions never grant access.

Conversation-local databases, documents, HTTP bodies and artifacts survive restart; other conversations and checkpoint branches receive separate stores. Skill databases and shared documents survive conversations and checkpoint branches; each new conversation must approve access. Existing Skill store keys remain unchanged for compatibility. Local stores use a reserved internal namespace that explicit Skill IDs cannot select. Body references remain in their selected scope: fetch and import with the same `skillId`, or omit it from both.

Grants are scoped to conversation + owner (the conversation itself or an explicit Skill) + exact HTTPS origin, database access mode, or shared documents. The persisted grant owner is an empty string for conversation tools, otherwise the Skill ID; empty/control-character Skill IDs are rejected in tool inputs. This preserves existing Skill grants without conflating them with general tool grants. Private documents behave like existing private file tools and need no shared-document grant. The app asks before first access, persists approvals, and offers revocation. No permission can be granted by a tool. Background requests are denied rather than opening prompts. Uninstall disables Skill access but preserves user data for reinstall.

HTTP is GET-only in this release (retry-safe reads); headers are app-controlled, no model-provided credentials or model-provider tokens are attached. Every redirect must remain HTTPS and receive its own origin grant before following. Bodies are streamed with an 8 MiB cap and 30 second deadline, stored by immutable reference in skill storage, and return only metadata and a short excerpt. Transport errors never include raw native exceptions or request URLs. Only content-type and last-modified headers are returned.

Each conversation-local scope and each Skill has a separate physical database, never the Pi database. Model-facing schema migrations, reads, and writes use a restricted declarative contract compiled into parameterized SQL. No arbitrary SQL, PRAGMA, ATTACH, extension loading, triggers, or executable expressions. Bounded reads support columns, comparisons, order and limit; results contain the generated SQL. Migrations create tables/add columns; transactional upserts use explicit primary keys. Executor-owned tables use reserved names and cannot be queried by agents. This deliberately restricts SQL to safe generated SELECTs rather than trying to sanitize arbitrary SQL.

JSON import selects an array by a property/index path and maps each output column from a path or constant with explicit scalar conversion. Entire datasets never enter model context. Imports validate all rows and commit upserts, an operation receipt, and successful refresh timestamp atomically. Write operation IDs are scoped to skill and supplied by agents; reusing an ID with different input is rejected. Committed receipts are checked before re-reading bodies on replay. Cancellation before commit rolls back; cancellation after commit leaves a replayable receipt. Native SQLite calls cannot be preempted midway; bounds and checks between calls limit cancellation latency. Reads can repeat; HTTP body references use the stable Pi tool task ID on replay; document writes and artifact creation use transactional receipts. App suspension pauses execution; Pi checkpoints do not guarantee background scheduling.

Documents are named records in the selected conversation-private or explicit Skill-shared namespace, with read/write/edit/list operations and explicit persistence scope in results. Skill resource reads expose SKILL.md and bounded HTTPS relative text resources, downloaded on demand after origin approval and cached in skill storage. Remote resource text is untrusted data. No linked scripts are executed.

Artifacts are immutable HTML/text records with usable `artifact:<id>` references. A conversation artifact list lets users reopen them after restart, preview HTML with JavaScript/network/navigation disabled, and invoke the native share sheet. Sharing requires a user tap, never an agent tool side effect. Files are exported to app cache for sharing. HTML is untrusted and rendered offline; external resources and active content are blocked.

## Limits and errors

Inputs are validated by Pi schemas and services. At most 32 tables/columns per schema request, 1,000 explicit writes, 50,000 imported rows, 200 query rows, 32 KiB model result, 128 KiB resource text, and 512 KiB documents/artifacts. Error codes distinguish permission, validation, transport, database, cancellation, and limits. Discovery returns tool schemas plus installed enabled skill resource references. User credentials are not available to these services.

## Acceptance and validation

Controlled HTTP → JSON → separate SQLite → bounded query tests must cover replay after reopen, changed-operation rejection, atomic rollback, cancellation, isolation, redirects, permission denial and output limits. Harness tests must prove registration, schema rejection and real tool execution. Mobile exports check Hermes bundling; native compilation and simulator operations are separate evidence. No real account/model requests are required for verification.

## Query example

After enabling a skill and approving database access, an agent can call `database_query` with:

```json
{
  "skillId": "<installed skill ID>",
  "table": "players",
  "columns": ["id", "name", "cost"],
  "where": [{ "column": "cost", "op": "<=", "value": 60 }],
  "orderBy": "cost",
  "descending": true,
  "limit": 10
}
```

The result includes the generated parameterized SELECT, bounded rows and a truncation flag. Use `database_inspect` first to discover actual tables/columns. This release intentionally supports generated SELECTs rather than arbitrary SQL or joins. HTTP is read-only GET; authenticated external integrations and non-idempotent HTTP writes need separate credential and durability contracts. Database grants do not imply HTTP or shared-document grants.

References remain in private skill storage; there is no total disk quota or automatic body garbage collection yet. Body references are stable for a recovered tool task, while a deliberately new request gets a new reference. Documents and resources expose `nextOffset` for bounded continuation. Uninstall preserves database content and caches; reinstalling the same source ID reopens them. Resource cache refresh currently requires a new relative path; cache-management UI is not included.

## Dependency sources

Native sharing follows [Expo Sharing](https://docs.expo.dev/versions/latest/sdk/sharing/). Offline preview controls follow [React Native WebView's reference](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Reference.md). The installed Expo SDK 58 fetch implementations were inspected for `redirect: manual` and `credentials: omit` on both platforms; Android reports `redirected` for an unfollowed 3xx, which is covered by regression tests.

## Verification on 2026-10-20

- `npm run verify`: passed, including 62 tests, TypeScript, portable runtime generation/audit, the isolated no-Node capability import/query/replay fixture, and Android/iOS Hermes exports. These exports are JavaScript resources, not APK/IPA builds.
- iOS native Debug build: `xcodebuild` succeeded with the new WebView/sharing dependencies. Installed on iPhone 17 Pro / iOS 26.2 simulator; all eight dedicated native smoke checks passed (import/query, rollback, document persistence, artifact persistence, import replay after reopen, artifact rediscovery, cross-conversation document access).
- Simulator UI: HTML preview displayed the report with its embedded script disabled; external navigation stayed in the preview. The user-triggered native share sheet displayed the HTML file and Save to Files action; dismissed without sending/exporting to another app.
- Harness tests use controlled faux model responses; native service smoke uses controlled HTTP and grants. Native permission-dialog interaction, live FPL endpoints, real model requests/account authorization, Android native compilation/device operation, and physical iOS devices were not verified.
- `npx expo-doctor`: 19/20 checks passed; the existing `react-native-tcp-socket` New Architecture metadata warning remains.
- `npm audit`: 23 affected package entries (15 high, 8 moderate), compared with 22 at baseline. `expo-sharing` adds a moderate affected root through the existing Expo config-plugin dependency chain. npm's proposed force fix downgrades SDK-compatible packages; it was not applied. WebView itself is not listed by this audit. No claim of a clean dependency audit.
- Independent read-only code review identified artifact filtering and query-output budgeting defects. Both have regression tests and fixes; follow-up review reported no further blocking findings.

## General-tool scope correction

Removed the requirement to enable a Skill before using general tools. Regressions exercise a real Harness HTTP call without any installed Skills, the full conversation-local fetch/import/query/document/artifact workflow, permission denial, namespace isolation, and persistence after reopen. Existing explicit Skill workflows remain covered. This correction does not add HTML article extraction or a stored-body text reader; HTTP still returns metadata, a body reference and a 512-character excerpt.

Follow-up validation of the scope correction: the controlled iOS simulator fixture passes all ten native service checks, including general HTTP with no installed Skills and conversation-isolated artifact discovery. The actual permission dialog displayed the conversation owner and HTTPS origin, and completed on Allow. Fixture permission approval does not grant access to real user data. Native dependencies are unchanged; this follow-up uses the previously compiled development client with regenerated runtime/Metro code.

The scope-correction `npm run verify` passed with 66 tests, TypeScript, no-Node portable smoke checks, and Android/iOS Hermes exports. Formatting and diff checks passed. Follow-up independent review found no actionable scope or compatibility issues.
