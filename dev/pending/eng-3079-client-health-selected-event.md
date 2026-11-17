## ENG-3079: client health reports whether the Meta optimisation event is arriving (2026-11-16)

- `assess_client_health` → `ads_layer.meta_connection_health.selected_event` was the literal `'unknown'`. It is now read live for a client with a connected Meta ad account: `readSelectedEventState` in `backend/src/services/clientHealthService.ts` calls the tracking monitor's own `fetchOptimisationInputs` and `evaluateAccountOptimisationCoverage` (`metaOptimisationCoverage.ts`). Nothing is stored.
- `missing` is the monitor's confirmed case (what it would alert on). `recent` means a pixel reported an optimisation event in the pixel's own window (about 24 hours) and nothing is confirmed missing. Everything else, including a failed or slow read, is `unknown`.
- The read starts beside the campaign reads and is cut off at `SELECTED_EVENT_READ_TIMEOUT_MS` (8 s).
- The monitor verdict gained an `arriving` list; the monitor itself does not read it.
- Not included: the monitor's day-1 detection, which needs the account-level history the health check does not fetch.
- Tests: `backend/src/__tests__/eng3079.clientHealthSelectedEvent.test.ts`.
