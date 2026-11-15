## ENG-2996: CRM import validation + suppression enforcement (2026-11-13)

- **Import follow-ups** (`backend/src/services/leadImportFollowups.ts`): bulk-import, CSV import,
  LinkedIn-connections import and Emma `add_leads_to_list` now pass the leads `batchCreateLeads`
  *created* to `applyLeadImportFollowups`. It (1) awaits do-not-contact inheritance: a new lead
  whose email belongs to an existing DNC/unsubscribed lead of the **same owner** (lead `userId`, or
  its list's owner) is flagged `contactStatus: 'do-not-contact'` before sequence auto-enrolment
  runs. A failed lookup is counted (`doNotContactCheckFailed` in the response), not read as clear;
  (2) fires `validateLeadEmailInBackground` once per distinct address (concurrency 8). Session lists
  skip validation (ENG-2311 side-effect policy). Merged/already-present rows are not touched.
- **Emma suppression**: `update_lead` / `update_lead_status` with pipeline status
  "do-not-contact" (any case/spacing, or "dnc") now also set `contactStatus` +
  `unsubscribedFromGroupEmail`, which is what `isDoNotContact` and `contactGuard.blockedRecipients`
  read. An already unsubscribed/DNC lead keeps its existing status and reason.
- **Group send/preview `excludeUnvalidated: true`** (opt-in): only leads whose
  `customFields.email_validation.status === 'deliverable'` are sent; never-validated, unknown and
  risky are reported as `skippedUnvalidated` / `unvalidatedCount`. Absent flag = unchanged
  behaviour and unchanged response shape.
- **Not done**: enrich.so credit balance in the admin view. The repo has no enrich.so
  balance/credits API client (`enrichSoService` only exposes validate/find/reverse-lookup), so
  per the issue this was skipped.
- No schema, migration or backfill. Existing leads imported before this change are not
  retroactively re-flagged.
