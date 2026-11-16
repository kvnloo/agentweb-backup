## ENG-3051: Emma tool delete_lead_engagement (2026-11-16)

- New Emma tool `delete_lead_engagement` (`list_id`, `lead_id`, `event_id`). It uses the same `canDestructiveCrmList` check and the same `crmDb.deleteLeadEngagement` write as `DELETE /api/crm/lists/:listId/leads/:leadId/engagements/:eventId`.
- Only engagements whose type starts with `custom.` can be deleted. System events are refused.
- Unknown list, lead or event id returns `success: true, deleted: false, found: false` with a hint to re-read with `get_lead_engagements`.
- Registered in the `crm` tool group, `CRM_MUTATING_TOOLS` and the gateway's per-lead failure scope. No table, key or index change.
- `remainingEngagementCount` counts engagements stored on the lead record. Email history lives in a separate table and is not in that number.
- Not fixed here: the unconditioned whole-array write inside `crmDb.deleteLeadEngagement` (ENG-3052).
