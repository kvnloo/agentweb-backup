## ENG-2783: Monthly cap on hot-lead calls per org, customer notices, honest settings read-out (2026-11-06)

Three things for hot-lead calling.

Monthly cap. New owner-approved model field `Organization.hotLeadCall.maxCallsPerMonth` (default 200, min 1, max 2000; a
config stored without it reads as 200, no migration). Owner routes (Emma `update_hot_lead_call_settings`, REST PUT) may set
1-200 only and refuse higher values with "Higher monthly limits are set by AgentWeb support"; a stored value above 200 (an
operator write) is shown and kept when the owner edits other fields. Enforced in `reserveCallSlot` after the hourly and
daily counters with a new limit-store key `hlc#cap#m#<orgId>#<YYYY-MM org-local>` (TTL 40 days), same unit as the daily cap
(leads, inbound callbacks not counted), released with the other slots on refusal. Skip reason `org_monthly_cap` on the lead
timeline; the Slack alert still goes out. New `LimitStore.read` (consistent counter read, notices only).

Customer notices. The org owner gets one email at ceil(80%) of the cap and one at the first refusal, per org per month,
via `emailService.sendEmail` (non-production suppressed by the resendService guard), de-duplicated by new key prefix
`hlc#notify#80#` / `hlc#notify#100#<orgId>#<YYYY-MM>` (TTL 40 days). Fire-and-forget, never blocks or fails a call. Log
a cap of 1-4 sends only the 100% email; a failed 100% send keeps its claim (logged `monthly cap 100% notice failed`), a failed 80% send is retried at the next crossing. The Emma enable approval card now also lists the monthly limit ("N per month"; the digest does not hash card text, so it is unchanged). Log markers `[hotLeadCall] org monthly cap 80% <orgId>` and `... 100% <orgId>` for alarms.

Honest read-out (two P1 findings from the QA tool on the previous PR). The settings read and preview now carry additive
`warnings` (Canada stored but not called yet); a Canada-only country list and calling hours that never meet the lead window
(sampled every 15 minutes across a week) are blockers (`blockers`/`canEnable`, refuse turning calling on). Preview gains
`outsideLeadHours` and `skipReason` (`outside_lead_hours`). Docs: `backend/docs/integrations/hot-lead-call.md`.
