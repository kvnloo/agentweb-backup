## ENG-2783: Platform-wide daily call cap with operator alert (2026-11-12)

Hot-lead auto-calls now have a platform-wide ceiling across all orgs: at most `HOT_LEAD_CALL_PLATFORM_DAILY_MAX` leads get a call per UTC day (default 300, a conservative builder-chosen start of about $45/day at ~$0.15 per lead call; the owner's to change; clamped to 100000, invalid values use the default with one warn). The next lead is skipped with `call.skipped` reason `platform_daily_cap` (no call, Slack alert still sent). The counter is taken last in `reserveCallSlot`, so an org refusal never leaks into it and a platform refusal rolls the org counters back; a press-2 retry counts too.

New env vars: `HOT_LEAD_CALL_PLATFORM_DAILY_MAX`, `HOT_LEAD_CALL_ALERT_EMAIL` (optional operator address; unset means log only).
New limit-store key families (existing `AW-MCPSessions` table, no table or index change): `hlc#cap#g#<UTC date>` (TTL 2 days), `hlc#notify#g80#<date>`, `hlc#notify#g100#<date>`.
Alert at 80% and 100% once per level per UTC day: ERROR log `[hotLeadCall] PLATFORM daily cap 80%` / `100%` (alarm hook) plus the email when configured.
Not verified against real DynamoDB beyond the existing `incrementBelow` (tests use the in-memory limit store). Runbook: `backend/docs/integrations/hot-lead-call.md`, "Platform-wide daily ceiling".
