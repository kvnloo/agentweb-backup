## ENG-3047: one run per scheduled fire in the due-schedule loop (2026-11-16)

- `runScheduledChats` (`backend/src/controllers/agentModeController.ts`) now passes the due time it
  and the last run time it read to `scheduleDb.updateScheduleAfterRun` when it advances a schedule
  to start a run. The write carries a `ConditionExpression` on both (`attribute_not_exists` for a
  schedule that has never run), so it lands only if the row is still as it was read. The last run
  time moves on every fire, so putting an old due time back does not let a stale caller through.
- The loop reads both values from `StatusStartTimeIndex`. That index projects all attributes
  (checked on the production and dev tables 2026-11-16). If its projection were ever narrowed to
  exclude `lastRunTime`, every schedule that has run would be refused.
- A caller whose advance is refused starts nothing, decrements nothing, and reports
  `already_started` for that schedule. Any other write error is handled as before.
- `updateScheduleAfterRun` takes the expected value as an optional fifth argument. Every other
  caller (delayed, waiting-for-variables, retries, the social engagement executor) passes none and
  keeps the unconditional write.
- Not behind `AGENT_RUN_STORE`; it applies wherever the due-schedule loop runs. No table, key,
  index or attribute change. `scheduledIdempotencyKey` still has no production caller.
- Also corrects a stale comment in `chatBranching.ts` that said the run store is off in production.
