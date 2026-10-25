# Android execution duration

## Decision

User-started Android agent runs have no Moose-imposed total duration limit. Remove the service's 30-minute cancellation timer and its notification/manifest wording. Keep the existing shared foreground service, notification permission requirement, 15-second startup handshake, explicit Stop action, 10-second cancellation acknowledgement deadline, and persistent stop reasons.

The partial wake lock remains time-bounded: acquire it for 10 minutes and renew every 5 minutes while this service generation is active. Service shutdown cancels renewal and releases the lock. A renewal failure stops renewal and enters the existing durable cancellation path with `wake_lock_failed`; it does not silently run without CPU protection. Renewal uses Android's main Handler and uptime clock, independently of React view updates. No new agent scheduler or model retry policy is introduced.

Waiting recurring tasks still release the service. There is no scheduled wakeup or automatic process restart. Android may suspend, restrict networking, or terminate the application; removing a local timer does not override those rules. Historical `budget_expired` diagnostics remain readable, but new service generations no longer produce that reason.

## Verification

Compile and execute the production wake-lock lifecycle helper on the JVM with a controlled clock, covering operation beyond 30 minutes, renewal before lock expiry, explicit stop, late callbacks and acquisition failure. These tests require JDK 17 or newer and run within `npm test`. Keep the existing execution-owner and durable cancellation regression tests.

Run the complete project verification. Android native compilation and device operation are separate evidence. On a physical phone, use a controlled task lasting over 35 minutes, verify completion before reopening, then check Stop and final resource release. No paid inference is required for controlled verification.
