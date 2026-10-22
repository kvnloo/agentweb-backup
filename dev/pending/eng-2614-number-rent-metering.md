## ENG-2614: hot-lead call number rent is metered every month (2026-10-22)

Until now only the first month of a caller number's rent was recorded, at purchase. A daily job (11:00 UTC, `cron/numberRentCron.ts`) now records the current calendar month's rent for every org that holds a number, charged to the org owner with the same event as the purchase. The event key is `twilio:number:<sid>:<YYYY-MM>` for both, so in the purchase month the job changes nothing and each later month adds one event. A released number or a deleted org stops being charged from the next run. There is no backfill.

Persistent configuration: the new environment variable `HOT_LEAD_CALL_RENT_METERING` (on when unset; `0`, `false` or `off` stops the job). No new table, index or org field; the new rows are spend events and usage rows of the existing shape.

Before enabling in production, run the read-only scan in the go-live checklist of `backend/docs/integrations/hot-lead-call.md` to see whether any org already holds a number. Months before this job existed would need a manual write, which needs Harsha's approval.
