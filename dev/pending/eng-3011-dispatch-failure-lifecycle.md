## ENG-3011: Apply scheduled-post failure lifecycle in dispatcher (2026-11-15)

The injected scheduled-post dispatcher now saves the existing markAttemptFailed lifecycle transition when publishing fails or throws. Retryable failures consume their attempt budget and wait for the existing backoff; permanent and exhausted failures become terminal. Dispatch summaries distinguish saved retries from failures. No scheduler, production caller, persistence implementation, or tool activation is added; ENG-2501's storage gate remains unchanged.

Verification: reproduced six failing dispatcher regressions before implementation; all nine scheduledPosts suites (118 tests), backend production build, full typecheck, and scoped ESLint pass. Regression coverage includes early retry ticks, attempt exhaustion, permanent failures, publisher throws, mixed-success batches, save failures, and stable idempotency keys.
