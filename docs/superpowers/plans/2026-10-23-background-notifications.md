# Background task notifications implementation plan

**Goal:** Show committed Android task progress and one result alert, with conversation routing.
**Architecture:** Extend the existing execution guard with conversation IDs. A small observer watches committed views during admitted work and reads the final view before releasing the existing service. Native code keeps the shared ongoing notification and posts per-conversation results on a separate alert channel. No executor or scheduler is added.
**Tech stack:** Pi Durable, Expo module, Android NotificationCompat, React Native Linking.

## Constraints and acceptance

- Preserve service admission, notification permission, Stop-all, cancellation acknowledgement and 30-minute budget.
- Observe only admitted work; an unchanged historical outcome cannot alert. Deduplicate overlapping leases for one conversation.
- Progress uses persisted state. Results are read after settlement before service release. Never include provider bodies or user text in notifications; failures use fixed categories.
- Multiple active conversations show a count without a misleading conversation target. Each completed conversation gets its own result target.
- Suppress result alerts while the Activity is resumed. Denied permission retains existing admission failure and loss cancellation semantics.
- Warm and cold URL handling validates an existing conversation and only selects it; no submission occurs. iOS gains no background guarantee.

## Work

- [x] Write failing observer tests covering persisted final reads, old failures, retries, overlapping leases, cancellation and bounded errors; implement the observer and guard ID propagation.
- [x] Extend native progress/result methods and notification intents, preserving stop causes. Add validated warm/cold conversation selection.
- [ ] Run complete verify, native compile and controlled emulator probes; record evidence and limits.
- [ ] Review diff, create PR, fix findings/checks, merge; increment actual latest patch version, tag and inspect release APK/manifest/signature/companion.
