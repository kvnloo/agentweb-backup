## ENG-2840: what an outside agent may write to a lead over MCP, and honest add/delete counts (2026-11-19)

`manage_leads` used to forward its body verbatim to the REST routes the customer portal uses. Emma's own lead tools do not: they forward eleven
standard fields, merge every other key into `customFields`, turn a do-not-contact status into a real suppression, and cannot write the
contact-status fields. The MCP actions now follow Emma (`backend/src/mcp/server/manageLeadsWrites.ts`); the REST routes are unchanged, so the
portal behaves as before.

- **update:** status `do-not-contact` (any case or spacing, or `dnc`) suppresses the lead. Other keys and an explicit `customFields` object are
  MERGED into the existing custom fields (the REST update replaces them). `contactStatus*`, `unsubscribedFromGroupEmail*`, server-owned keys
  (sync, attribution, auto-send marker) and identity keys (`userId`, `tenantId`, `accountOwnerUserId`, `listId`, `leadId`, `client_id`) are
  refused by name: an agent can suppress a lead, never un-suppress one, and cannot say whose lead it is.
- **add:** 1 to 100 leads. One lead answers as before; several are created one by one and the answer counts created / duplicate / failed per
  row. Same field rules as update (the REST add route stores the body as given, including a client-supplied `userId` / `tenantId`). A refused
  row stops the whole call before anything is created. Dry-run preview and the admin `client_id` add stay exactly one lead.
- **delete:** 1 to 100 ids. The REST DELETE removes by key without checking the lead exists and then lowers the list's lead count, so a
  missing (or other list's) id reported success and miscounted the list. Each id is read first (a missing one is a 404), and the answer counts
  what was really deleted. If none of several succeeded the call is an error.
- **list:** `page`, `search`, `status`, `engaged_only` reach the route that reads them. The old `last_key` was never read by the route, so key
  pagination never worked; it is removed.
- **create_lead_list update:** Emma's eight fields (name, description, icps_only, engaged_only, auto_draft_enabled, auto_draft_instruction,
  status_config, list_type once). Auto-send, alert copies to outside addresses, list sender and the LinkedIn account are never forwarded.

**Test infrastructure.** The fake DynamoDB now supports `list_append(if_not_exists(...), ...)` and a comparison on the range key in a query
(before, every duplicate-email check returned the whole partition, so every add looked like a duplicate). The harness answers the tools'
self-call with a plain object: `Response.json()` builds objects in the outer Node realm, which `customFieldsGuard`'s prototype check rejects.
The behaviour is proved through the real path in `mcp.manageLeads.writes.test.ts`.

**Not done here (separate slices):** per-call credit metering and org-bound keys; the `CRM_LEAD_PUT_GUARD` env switch (ops) still defaults to
log for the portal route; the REST DELETE existence check itself.
