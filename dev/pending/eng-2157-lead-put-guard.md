## ENG-2157: lead PUT route reports/drops server-owned keys, audits suppression changes, and accepts PATCH (2026-10-12)

`PUT /api/crm/lists/:listId/leads/:leadId` handed its whole body to `crmDb.updateLead` (~50 keys). Verified live on the preview that an editor could set or clear `lastAutoSendAt`,
forge `syncMetadata.hubspot_contact_id`, `system`, `firstTouch`/`utmSource`/`clickIds`, pass the internal write flags (`customFieldsKeyMerge`, `skipFieldNamesUpdate`), and
forge who/when changed a suppression (`contactStatusUpdatedBy/At`, honoured whenever `contactStatus` is in the body). No customer-portal code sends any of those, and Emma's own `update_lead` filters to
11 fields. The MCP `lead.update` action forwards its body verbatim, so real usage there is unknown.

- `CRM_LEAD_PUT_GUARD=log|enforce|off`, default **log**: reports which server-owned keys arrive (key names, channel, user id; never values) as `[crm-lead-put-guard] {json}` and changes nothing.
  `enforce` drops them and stamps `contactStatusUpdatedBy` with the authenticated user. Read the log for a week before flipping it; MCP usage is the unknown.
  `aws logs filter-log-events --log-group-name <web.stdout.log group> --filter-pattern '"crm-lead-put-guard"'`
- Do-not-contact / unsubscribe keys are NOT dropped (the portal's Mark DNC, Remove and Resubscribe buttons write them here). A real change to `contactStatus` or `unsubscribedFromGroupEmail` now appends a
  `contact_status.changed` engagement with the authenticated actor (and the delegating admin), a server timestamp and fixed vocabulary only (an unvalidated client string never reaches the event: the
  engagement layer raises `isEngaged` on the words clicked/replied/received). It never blocks or fails the write. `CRM_CONTACT_STATUS_AUDIT=off` disables it.
  The event data is FLAT strings/booleans (`fromStatus`, `toStatus`, `fromGroupEmailUnsubscribed`, `toGroupEmailUnsubscribed`, `reason`, `actorUserId`, `delegatedByUserId`, `channel`, `via`, `note`): the portal's
  Engagements dialog (CRM.tsx) renders `eventData.from` / `eventData.to` as React children for every event type, so an object there would crash it. That dialog is currently unreachable (no caller since engagements moved into the lead drawer), so this is defensive, not a live crash; a test pins the flat shape.
  The trail is best-effort and PARTIAL: it records changes made through this route only (not bulk-contact-status, Emma's update_lead, the public unsubscribe, webhooks or the bounce cron), and the before-state is read
  before the write with no compare-and-swap, so two concurrent changes can both record the same `from`.
- `PATCH` on the same path now runs the same handler. The portal's deal editor (`DealSection`) has always sent PATCH here; the route did not exist, the fetch swallowed the 404, and deal edits vanished on reload.
  Note: DealSection sends the WHOLE `customFields` map built from its local state, so a deal edit rewrites the map (no key-merge) and can overwrite keys written since the page loaded (enrichment, Emma). The drawer's
  `patchCustomField` already does the same through PUT, so this is not a new class of risk, but PATCH newly exposes it to the deal editor. An object-valued `deal` also registers a `deal` name in the list's field names.
  In `enforce` mode `contactStatusUpdatedBy` is stamped with the authenticated user whenever `contactStatus` is present and not null (updateLead then writes the actor/time pair for any value).

Not changed: clearing a suppression is still allowed (product behaviour). Enforcing a compliance-field allowlist needs a dedicated single-lead endpoint and a customer-portal change (separate repo).
