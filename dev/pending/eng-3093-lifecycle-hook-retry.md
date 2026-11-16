## ENG-3093: termination guard keeps retrying the lifecycle hook answer until the hook opens (2026-11-16)

- `backend/src/services/asgLifecycleGuard.ts`: `COMPLETION_MAX_ATTEMPTS` 15 -> 49 and `COMPLETION_RETRY_DELAY_MS` 1000 -> 15000. The guard now retries the "No active Lifecycle Action found" reply every 15 s for up to 12 minutes, instead of giving up after 14 s. The hook only opens after the load balancer's 600 s connection draining.
- Any other `CompleteLifecycleAction` error is still not retried. The answer is still sent only after the app's drain has returned.
- The 12 minutes stay under `runDrain`'s force-exit timer (drain ceiling + 3 min) in `backend/src/server.ts`.
- Not changed: the 600 s draining, the hook, the Auto Scaling group, the deploy script.
- Tests: `backend/src/__tests__/asgLifecycleGuard.test.ts` (18 cases; one new, one updated).
