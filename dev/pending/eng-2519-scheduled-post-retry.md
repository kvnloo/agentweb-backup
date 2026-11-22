## ENG-2519: Pure scheduled-post failure/retry transitions (2026-10-16)

Adds `failed` status, `attempts`/`lastError`, and `markAttemptFailed` (1m/5m/25m backoff, MAX_ATTEMPTS=3) to `scheduledPostLifecycle.ts`. Pure, no persistence.
