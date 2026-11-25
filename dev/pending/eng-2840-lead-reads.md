## ENG-2840: Lead reads for outside agents over MCP (2026-11-25)

- Three tools that Emma has now exist on the MCP server: `get_lead_details`, `get_lead_engagements`, `get_lead_list_statuses`
  (`backend/src/mcp/server/leadReadTools.ts`). `manage_leads get` returns the stored lead only; `get_lead_details` adds the engagement
  summary, the 10 most recent engagements, the LinkedIn connection status, and finds the lead when the list id is stale (only inside lists
  the caller can access). `get_lead_engagements` is the history of one lead, newest first, `limit` 1 to 100 (default 20) with the counts
  beside it. `get_lead_list_statuses` returns a list's pipeline stages, including the default a list that never stored its own uses (which
  `create_lead_list get` does not show).
- Same pattern as the other wave-2 tools: the handler checks arguments by name (an unknown argument, including any identity such as
  `user_id`, `client_id`, `orgId`, is refused by name), then self-calls the `/api/emma` route as the key's own user. The list access check
  (`canOrgMemberAccessList`: the list owner, or a member of the owner's organization while the organization shares its CRM) runs in
  Emma's handler on the far side and is not replaced.
- `/api/emma/*` answers a refusal as HTTP 200 `{ success: false, message }`. The tools turn that into an error carrying only the route's
  short `message`; the route's `error` field (raw exception text on an internal failure) is dropped. Two thin routes were added for the
  tools that had none: `POST /api/emma/lead-engagements` and `POST /api/emma/lead-list-statuses`, both `metered` like `/leads` and
  `/lead-details` (an account over its monthly token quota is refused on them as on those).
- Not `readOnly`, on purpose: the first read of an email event can fetch its content from the mail provider and store it, and a LinkedIn
  lead can trigger a check of the connected account. A key that holds only `tools:read` cannot call them (same as `manage_leads` and
  `search_leads`). Nothing in the lead changes. The tools are found with `emma_search_tools`, not in the default tool list.
- Not exposed here, and why: `get_hot_leads`, `get_leads_needing_followup`, `get_lead_conversation_statuses` (each reloads the whole email
  history of the account's domain on every call), `analyze_crm_data` and `ask_crm` (spend the platform's model key), `log_contact_event`
  (writes to a global table keyed by an email taken from the argument, with no ownership check).
- Still true after this change: external answers pass through the public response sanitiser (drops `ipAddress`, `userAgent`, `debug`,
  `telemetry` at any depth, visits at most 10,000 nodes); the lead reads keep Emma's per-call limits; the engagement history of a lead
  with email events is read for the whole lead before it is cut to `limit`.
- Proof: unit tests of the request builders and refusals (`mcp/server/__tests__/leadReadTools.test.ts`), the two routes against Emma's
  real handlers (`emmaApi.leadReadback.test.ts`), and two tenants through the real MCP server, tool, route, handler and in-memory database
  (`mcp.leadReads.twoTenant.test.ts`). The email-event half of an engagement read is not covered there (AW-EmailEvents is not in the fake).
