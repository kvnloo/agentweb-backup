## ENG-2783: Lead prompt with callback number and press 3 stop; press 2 retry not built (2026-11-06)

New lead screening prompt (US only; Canada stays refused by `HOT_LEAD_CALL_CA_ENABLED=false`): "This is an automated call from
{name} about the enquiry you sent us. To reach a person at {name}, call {org number, spoken in 3-3-4 digit groups}. Press 1 to be
connected now, or press 3 to stop these calls." (The org number rings the team through the existing inbound callback path.)
Press 1 connects as before; any other key (2 included) or no input is unconfirmed/declined as before. `/screen` aborts the call
(outcome `aborted`) when the org number is missing or not E.164.

Press 3 = stop: outcome `lead_opted_out` with the existing `call.lead_declined` event (`reason: opted_out`), the lead hears a goodbye,
the member hears "The lead asked not to be called again", nothing connects, a later 1 cannot reverse it. The org marker is claimed
up to 3 times in-process before the outcome is recorded; if all fail, an error `[hotLeadCall] do-not-call write failed <orgId>` is
logged (the stop then rests on that lead's contact status only). New skip gate `do_not_call` (async, after the plan check, dispatch
and job) and a `/gather` re-check (`call.failed` reason `lead_do_not_call`); both block ONLY on the org marker or a lead status of
exactly `do-not-contact` (an email unsubscribe, bounce or legacy flag does not block). Press 3 also sets the legacy
group-email unsubscribe flag, like the CRM's own do-not-contact action.

Owner-approved data-plane additions (Anurag): (1) new key family `hlc#dnc#<keyed digest of org + number>` in the existing
`AW-MCPSessions` limit store, ~10 year TTL, no raw number (keyed by `JWT_SECRET`: rotating it empties the list, see the docs);
(2) a new writer of the existing lead `contactStatus` (`do-not-contact`, reason `opted-out`) fields. The planned
`system.hot_lead_call` deferral fields are NOT added.

NOT built: press 2 "call me again later" (one deferred retry). The job queue has no run-after, so no new infrastructure was
invented and the prompt does not offer 2. Wording and options: `backend/docs/integrations/hot-lead-call.md`, Known follow-ups.

### Fix: calling-hours/lead-window overlap check is exact (QA P1 on #3918)
`callingHoursReachLeadWindow` no longer samples every 15 minutes (a calling window shorter than 15 minutes could fall between samples and block
enabling). It now decides at minute resolution over eight days: the lead window is asked once per UTC hour (its edges are whole hours), and the
org window is read twice per open hour with the minutes in between computed. Worst case (no overlap) about 75 ms cold.
