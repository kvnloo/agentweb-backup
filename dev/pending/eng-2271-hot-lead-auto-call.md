## ENG-2271: hot-lead auto-call, Emma rings a team member and bridges the lead (2026-10-19)

When a landing-page form lead with a phone number arrives, Emma can ring a team member's own phone from a Twilio number; if the member presses 1, Emma dials the lead and bridges the two. Everything is dark by default: nothing runs unless the AW-Settings item `hot_lead_call_mode` is `on` AND an org has a valid, enabled `hotLeadCall` config. The existing Slack lead alert is untouched and still fires for every lead.

What is in it: Twilio foundation (credentials from `dev|prod/AgentWeb/Twilio`, `VoiceProvider` seam, kill switch), `hotLeadCall` org config + Emma tools (`get/update_hot_lead_call_settings`, plus `provision_hot_lead_call_number`, `release_hot_lead_call_number`, `start/confirm_hot_lead_call_verification`), the orchestrator (create-first call record on the lead, one call record per lead ever), signed Twilio voice webhooks under `/api/webhooks/twilio-voice`, abuse limits (quiet hours, per-org hourly/daily caps, member cooldown, per-phone 24h dedupe), spend metering (`twilio` in the vendor rate card with PROVISIONAL list-price rates, editable in Admin > Revenue & billing > Vendor Rates via the `vendor_rate_overrides` setting), an end-to-end test and a runbook.

Operate it: `backend/docs/integrations/hot-lead-call.md` (operator quick reference, setup order, kill switch, stuck-record runbook, go-live checklist, and what could not be verified without a real Twilio account).

Data-plane items (new persistent keys, no new tables or indexes): org attributes `hotLeadCall`, `hotLeadCallVerification`, `hotLeadCallProvisioning`; AW-Settings items `hot_lead_call_mode` and `vendor_rate_overrides`; `lead.system.hot_lead_call` record; `hlc#` counter/claim items in the existing `AW-MCPSessions` table (confirm the table exists in prod with TTL on `ttl` and that the app role can write it).

Not done / before general availability: a human-approval gate for the number provision/release tools, recurring monthly number-rent metering, compliance sign-off for calling leads, the real rate card from Harsha, a staging run with real phones.
