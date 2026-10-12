## ENG-2157: lead PUT route reports/drops server-owned keys, audits suppression changes, and accepts PATCH (2026-10-12)

`PUT /api/crm/lists/:listId/leads/:leadId` handed its whole body to `crmDb.updateLead` (~50 keys). Verified live on the preview that an editor could set or clear `lastAutoSendAt`,
forge `syncMetadata.hubspot_contact_id`, `system`, `firstTouch`/`utmSource`/`clickIds`, `accountOwnerUserId`, pass the internal write flags (`customFieldsKeyMerge`, `skipFieldNamesUpdate`), and
forge who/when changed a suppression (`contactStatusUpdatedBy/At`, honoured whenever `contactStatus` is in the body). No customer-portal code sends any of those, and Emma's own `update_lead` filters to
11 fields. The MCP `lead.update` action forwards its body verbatim, so real usage there is unknown.

- `CRM_LEAD_PUT_GUARD=log|enforce|off`, default **log**: reports which server-owned keys arrive (key names, channel, user id; never values) as `[crm-lead-put-guard] {json}` and changes nothing.
  `enforce` drops them and stamps `contactStatusUpdatedBy` with the authenticated user. Read the log for a week before flipping it; MCP usage is the unknown.
  `aws logs filter-log-events --log-group-name <web.stdout.log group> --filter-pattern '"crm-lead-put-guard"'`
- Do-not-contact / unsubscribe keys are NOT dropped (the portal's Mark DNC, Remove and Resubscribe buttons write them here). A real change to `contactStatus` or `unsubscribedFromGroupEmail` now appends a
  `contact_status.changed` engagement with the authenticated actor (and the delegating admin), a server timestamp and fixed vocabulary only (an unvalidated client string never reaches the event: the
  engagement layer raises `isEngaged` on the words clicked/replied/received). It never blocks or fails the write. `CRM_CONTACT_STATUS_AUDIT=off` disables it.
- `PATCH` on the same path now runs the same handler. The portal's deal editor (`DealSection`) has always sent PATCH here; the route did not exist, the fetch swallowed the 404, and deal edits vanished on reload.

Not changed: clearing a suppression is still allowed (product behaviour). Enforcing a compliance-field allowlist needs a dedicated single-lead endpoint and a customer-portal change (separate repo).
