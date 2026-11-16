## ENG-3047: one run per scheduled fire in the due-schedule loop (2026-11-16)

- `runScheduledChats` (`backend/src/controllers/agentModeController.ts`) now passes the due time it
  read (`schedule.nextRunTime`) to `scheduleDb.updateScheduleAfterRun` when it advances a schedule
  to start a run. The write carries `ConditionExpression: #nextRunTime = :expectedNextRunTime`, so
  it lands only if the row still has that due time.
- A caller whose advance is refused starts nothing, decrements nothing, and reports
  `already_started` for that schedule. Any other write error is handled as before.
- `updateScheduleAfterRun` takes the expected value as an optional fifth argument. Every other
  caller (delayed, waiting-for-variables, retries, the social engagement executor) passes none and
  keeps the unconditional write.
- Not behind `AGENT_RUN_STORE`; it applies wherever the due-schedule loop runs. No table, key,
  index or attribute change. `scheduledIdempotencyKey` still has no production caller.
- Also corrects a stale comment in `chatBranching.ts` that said the run store is off in production.
