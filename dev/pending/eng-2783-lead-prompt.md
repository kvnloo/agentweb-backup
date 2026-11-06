## ENG-2783: Lead prompt with callback number, press 2 not-available-now retry, press 3 stop (2026-11-06)

New lead screening prompt (US only; Canada stays refused by `HOT_LEAD_CALL_CA_ENABLED=false`): "This is an automated call from
{name} about the enquiry you sent us. To reach a person at {name}, call {org number, spoken in 3-3-4 digit groups}. Press 1 to be
connected now, or press 3 to stop these calls." (The org number rings the team through the existing inbound callback path.)
Press 1 connects as before; any other key (2 included) or no input is unconfirmed/declined as before.

Press 3 = stop: outcome `lead_opted_out` with the existing `call.lead_declined` event (`reason: opted_out`), the lead hears a goodbye,
the member hears "The lead asked not to be called again", nothing connects, a later 1 cannot reverse it. New skip gate `do_not_call`
(async, after the plan check, dispatch and job; also honours any `do-not-contact`/`unsubscribed` lead status) and a `/gather`
re-check (`call.failed` reason `lead_do_not_call`). A marker-write failure fails closed (no connect, warning without the number).

Owner-approved data-plane additions (Anurag): (1) new key family `hlc#dnc#<keyed digest of org + number>` in the existing
`AW-MCPSessions` limit store, ~10 year TTL, no raw number; (2) a new writer of the existing lead `contactStatus`
(`do-not-contact`, reason `opted-out`) fields. The planned `system.hot_lead_call` deferral fields (count, retryAfter) are NOT added.

NOT built: press 2 "call me again later" (one deferred retry). The job queue has no run-after (a `pending` row is claimed by the next
30 s poll; `enqueueJob` has no delay option) and nothing else schedules per-lead work, so per the instruction no new infrastructure was
invented and the prompt does not offer 2. Wording ready for when it exists: "Press 1 to be connected now, press 2 if you are not
available and we will call you again later, or press 3 to stop these calls." Docs: `backend/docs/integrations/hot-lead-call.md`.
