## ENG-2783: Lead-local calling hours; Canada off at launch (2026-11-06)

Hot-lead calls now also respect the lead's own local time. New `services/voice/leadLocalHours.ts`
(`isInsideLeadCallWindow`): 10:00 inclusive to 18:00 exclusive (`LEAD_CALL_START_MINUTES`/`LEAD_CALL_END_MINUTES`; a
business decision, stricter than the legal 08:00-21:00), every day, with no area-code table: a US number must be
inside the window in both America/New_York and America/Los_Angeles (effectively 13:00-18:00 Eastern); 808 (Pacific/Honolulu) and
907 (America/Anchorage) must also hold their home zone on top of Eastern and Pacific (a narrow band, since mobile
numbers move); anything else is refused. New skip reason `outside_lead_hours` (stateless
gate after `outside_calling_hours`, dispatch and job) and a `/gather` re-check that records `call.failed`
`lead_outside_hours` and plays the unreachable message without dialling.

Canada is refused in code (`HOT_LEAD_CALL_CA_ENABLED = false`, reason `country_not_allowed`) until the CRTC ADAD
identification message (email/postal address, local or toll-free number) is built and `leadLocalHours.ts` gets a Canada
branch; the stored config, default and validation are unchanged.
No persisted-field or table change. Docs: `backend/docs/integrations/hot-lead-call.md`.
