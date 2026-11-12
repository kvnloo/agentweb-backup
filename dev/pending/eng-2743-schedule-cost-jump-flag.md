## ENG-2743: daily oncall flag for scheduled runs whose cost jumps (2026-11-12)

New daily cron `backend/src/cron/scheduleCostJumpCron.ts` (registered in `server.ts`, behind `isCronEnabled()`), read-only. It reads the usage ledger (`usageRecordDb.scanByDateRange`, the last complete UTC day plus the 7 days before it) and sums each schedule's agent-loop cost per day (feature `agent_task:scheduled:<scheduleId>`, all models together). A schedule is flagged when that day cost at least $3 and at least 2x the median of its billed days in the previous 7 (needs at least 3 billed days; new schedules are skipped). All flagged schedules go out as ONE oncall email (`sendAgentModeOncallAlert`, recipients = the `oncall_emails` setting), deduped per evaluated day in-process.

Backtest on the prod ledger (Oct 25 - Nov 11, nothing sent): flags Nuerraa's newsletter `b2bce0d0` on Oct 26/28/29 (3.8-5.7x), `04b34124` on Nov 1 ($33.60, 7.4x, Opus calls) and Oct 26/28, plus two smaller jumps (Oct 29, Nov 3); nothing Nov 4-11. A gradual climb that never doubles in one day (hourly `0052c195`, $5.6 -> $11.6 over five days) is not flagged.

No new setting, table or write. Thresholds are constants in the module. A redeploy on the same day can repeat that day's digest (in-process dedupe), same as the other daily digests. The per-run cap itself stays with ENG-2812.
