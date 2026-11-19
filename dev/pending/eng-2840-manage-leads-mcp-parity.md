## ENG-2840: what an outside agent may write to a lead over MCP, and honest add/delete counts (2026-11-19)

`manage_leads` used to forward its body verbatim to the REST routes the customer portal uses. Emma's own lead tools do not: they forward eleven
standard fields, merge every other key into `customFields`, turn a do-not-contact status into a real suppression, and cannot write the
contact-status fields. The MCP actions now follow Emma (`backend/src/mcp/server/manageLeadsWrites.ts`); the REST routes are unchanged, so the
portal behaves as before.

- **update:** the lead is always read first (a missing id is a 404; the REST update would otherwise create a one-field row). Status
  `do-not-contact` (any case or spacing, or `dnc`) suppresses the lead. Other keys and an explicit `customFields` object are MERGED into the
  stored custom fields (the REST update replaces them). The merge starts from the STORED lead, not the REST copy: the REST read hides
  card-revenue fields from viewers who may not see them and writing that copy back would delete them. If the stored lead cannot be read nothing
  is saved. `contactStatus*`, `unsubscribedFromGroupEmail*`, server-owned keys (sync, attribution, auto-send marker), identity keys (`userId`,
  `tenantId`, `accountOwnerUserId`, `listId`, `leadId`, `client_id`) and the bare `utm` / `attribution` are refused by name: an agent can
  suppress a lead, never un-suppress one, and cannot say whose lead it is. A refused name can still be stored inside `customFields`.
- **add:** 1 to 100 leads. One lead answers as before (the created lead); several are created one by one and the answer counts created /
  duplicate / failed per row, and the same address twice in one call is a duplicate without asking the route (its check reads a lagging index).
  Same field rules as update. Drafts (`emailDraft`, `messageDraft`, `emailDraftFormat`) are refused on add: `createLead` never stores them, so
  they would be dropped while the call reported success; an update saves them. Source tracking is accepted only as
  `attribution: { utm: { source, medium, campaign, content, term } }` (short strings): click ids, referrer and landing URL feed the account's
  ad-conversion relay and stay system-owned. A new lead cannot be created with status do-not-contact (it would be labelled, not suppressed).
  An address the owner already marked do-not-contact is flagged on the new lead too, as every bulk import does (`leadImportFollowups`; the
  single-lead REST route does not); the answer says so. A refused row stops the whole call before anything is created. Dry-run preview and the
  admin `client_id` add stay exactly one lead (the admin add also runs the inheritance, as the admin).
- **Field types and CRM fields (added after the fresh review of the final head):** a standard field of the wrong type is refused by name; `status` must be non-empty text (the update route records the status change with the value as given BEFORE it validates the write, so an object there left a malformed engagement on the lead). The CRM fields the verbatim forward used to honour keep working (create layer: `domain`, `pocEmails`, `priority`, `role`, `isPrimary`, `expectedClose`, `closedDate`, `heatScore`, `healthScore`, validated by the create layer; the update layer persists only `domain` and `pocEmails`), while `dealIds` (a link to another record), `icpMatch` and `enrichmentMetadata` are refused by name. The custom-field merge starts from a CONSISTENT read of the stored lead (the merged map is written back whole). Changing a lead's email to an address the owner already marked do-not-contact flags the lead too. A lead marked do-not-contact is NOT deleted through the tool (deleting it would let the address be re-added as sendable); when the do-not-contact check itself fails, the answer names the leads that were not checked (`doNotContactUnchecked`). A refused row in a multi-row add is named; a list update whose `status_config` repeats a status value is refused.
- **delete:** 1 to 100 ids. The REST DELETE removes by key without checking the lead exists and then lowers the list's lead count, so a missing
  id reported success and miscounted the list. Each id is read first (a missing one is a 404) and the answer counts what was really deleted.
- **time budget:** one add or delete call stops starting new rows after 90 s and reports the rest as `not_attempted`, so only those are sent
  again. The budget limits when a row starts, not how long one row's self-call may take.
- **list:** `page`, `search`, `status`, `engaged_only` reach the route that reads them. The old `last_key` was never read by the route, so key
  pagination never worked; it is removed.
- **create_lead_list update:** Emma's eight fields (name, description, icps_only, engaged_only, auto_draft_enabled, auto_draft_instruction,
  status_config, list_type once). Auto-send, alert copies to outside addresses, list sender and the LinkedIn account are never forwarded. An
  instruction over 2000 characters is refused before any field is saved; if the second save fails the error says the first was saved.

**Found in the REST routes, NOT changed here (separate card for the owner/Harsha):** `DELETE /lists/:l/leads/:id` has no existence check and
still lowers the lead count; the single-lead `POST` skips do-not-contact inheritance; `PUT /lists/:l/leads/:id` creates a row for an unknown id.
Suppression is per lead: deleting an opted-out lead and re-adding the address leaves no flag. `findAllLeadsByEmail` caps at 200 rows across all
tenants (shared with the bulk imports). A custom-field update racing another write to the same lead can lose keys (Emma's own update has the same
pattern). The suppression update sends `contactStatusUpdatedAt/By`, which `CRM_LEAD_PUT_GUARD` counts as server-owned keys on the agent channel.

**Test infrastructure.** The fake DynamoDB now supports `list_append(if_not_exists(...), ...)` and a comparison on the range key in a query
(before, every duplicate-email check returned the whole partition, so every add looked like a duplicate), and the harness has the
`EmailLookupIndex`. The harness answers the tools' self-call with a plain object: `Response.json()` builds objects in the outer Node realm, which
`customFieldsGuard`'s prototype check rejects. The behaviour is proved through the real path in `mcp.manageLeads.writes.test.ts`.

**Not done here (separate slices):** per-call credit metering and org-bound keys; the `CRM_LEAD_PUT_GUARD` env switch (ops) still defaults to
log for the portal route; the REST fixes above.
