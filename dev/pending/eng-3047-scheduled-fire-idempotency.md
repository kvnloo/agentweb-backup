## ENG-3047: one run per scheduled fire in the due-schedule loop (2026-11-15)

- `runScheduledChats` (`backend/src/controllers/agentModeController.ts`) now claims
  `scheduledIdempotencyKey(scheduleId, "<stored nextRunTime>|<stored lastRunTime>")` through
  `claimIdempotency` with `IDEM_TTL_SCHEDULED_S` (24h) after it advances the schedule and before it
  starts the run. A caller that loses the claim starts nothing and reports `already_started`.
- Only active when `AGENT_RUN_STORE=true` (true in production, unset on staging as of 2026-11-15).
  Reuses the existing `idem#` rows in `AW-AgentRuns`; no table, key, index or attribute change.
- If the claim call throws, the run starts anyway and the error is logged with `[ENG-3047]`.
- The key includes the stored last run time so a schedule set back to a due time it already ran at
  still fires. Manual test runs and the two variable-submission paths take no claim.
- Not fixed here: both racing callers still call `updateScheduleAfterRun`, so a run-limited
  schedule can have `runCount` decremented twice for one fire.
