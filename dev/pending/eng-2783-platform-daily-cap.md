## ENG-2783: Platform-wide daily call cap with operator alert (2026-11-12)

Hot-lead auto-calls now have a platform-wide ceiling across all orgs: at most `HOT_LEAD_CALL_PLATFORM_DAILY_MAX` leads are attempted per UTC day (a slot stays taken once a record is created, even if Twilio rejects the call) (default 300, a conservative builder-chosen start of about $45/day at an order-of-$0.15 per-lead estimate, not a measurement: about two legs of ~5 minutes at $0.014/min, retries and other costs excluded; the owner's to change; clamped to 100000, invalid values use the default with one warn). The next lead is skipped with `call.skipped` reason `platform_daily_cap` (no call, Slack alert still sent). The counter is taken last in `reserveCallSlot`, so an org refusal never leaks into it and a platform refusal rolls the org counters back; a press-2 retry counts too.

New env vars: `HOT_LEAD_CALL_PLATFORM_DAILY_MAX`, `HOT_LEAD_CALL_ALERT_EMAIL` (optional operator address; unset means log only).
New limit-store key families (existing `AW-MCPSessions` table, no table or index change): `hlc#cap#g#<UTC date>` (TTL 2 days), `hlc#notify#g80#<date>`, `hlc#notify#g100#<date>`.
Alert at 80% and 100% once per level per UTC day: ERROR log `[hotLeadCall] PLATFORM daily cap 80%` / `100%` (alarm hook) plus the email when configured.
Not verified against real DynamoDB beyond the existing `incrementBelow` (tests use the in-memory limit store). Runbook: `backend/docs/integrations/hot-lead-call.md`, "Platform-wide daily ceiling".

The ceiling cannot be disabled by an operator, only raised (max 100000). A failed alert email keeps the claim at both levels (marker logs once per level per day). The press-2 retry path of the ceiling (transient, rescheduled, expiry at firstDueAt + 6h) is covered by a new e2e in `hotLeadCall.e2e.retry.test.ts`; nothing was run against real DynamoDB.
- Review follow-up: the alert is keyed by the UTC day the reservation counted (carried as `at` on the platform refusal and on success), so a reservation straddling midnight cannot claim the wrong day; a count that lands on the cap also sends the 80% alert when none was sent (both reached levels are processed).
