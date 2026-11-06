## ENG-2783: Press 2 'not available now' schedules one retry via a due-retries cron (2026-11-06)

The lead prompt again offers three options: "Press 1 to be connected now, press 2 if you are not available and we will call you again
later, or press 3 to stop these calls." (US only). A 2 at the lead screen records outcome `lead_deferred` (event `call.lead_declined`,
`reason: not_available_now`); the lead hears "Okay. {name} will call you again later. Goodbye.", the member "The lead is not available
right now. We will try again later." One retry per lead, ever: on the retry call a 2 is a plain decline ("... will not call again today").
Replays and a later 1 cannot create a second deferral or connect; a 3 still stops (do-not-call marker and contact status win and
the deferral is removed).

The retry is due 60 minutes after the press, moved forward minute by minute (up to 36 hours) to the first minute inside the lead-local
window and the org's calling hours; with none, the 2 is a plain decline. A new cron, `cron/hotLeadCallRetryCron.ts`, armed in
`server.ts` every 5 minutes (env `HOT_LEAD_CALL_RETRY`: unset = on, `off`/`0`/`false` = off; it does nothing while the global
`hot_lead_call_mode` kill switch is off), finds due deferrals the way the stuck sweep finds records, claims each with a conditional
write (exactly once under overlapping runs or instances) and re-runs the normal dispatch pipeline: every gate again (the existing-record
short-circuit and `too_old` are ignored), a fresh slot against the hourly, daily and monthly caps, fresh member selection with the
cooldown, then the normal member and lead screens. More than 6 hours late: `call.skipped` `retry_expired`. A refused or failed retry is
spent (one retry). The stuck sweep leaves a waiting deferral alone (it is a finished record).

Owner-approved data-plane additions (Anurag): new schemaless fields on the existing `system.hot_lead_call` sidecar map of the lead row
(`deferral {dueAt, count}`, `retryClaimToken`, `retryClaimedAt`); NO new table, index or GSI. The retry's restart revives a finished
record (new `jobKey`, attempt 1, emptied `meteredLegs`/`lastSequence`), and `findLeadsBySystemRecord` gained optional attribute filters.
Operators cancel a pending retry with a data write (see `backend/docs/integrations/hot-lead-call.md`, "Press 2 and the retry").
