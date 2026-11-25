## ENG-2840: Lead reads for outside agents over MCP (2026-11-25)

- Three tools that Emma has now exist on the MCP server: `get_lead_details`, `get_lead_engagements`, `get_lead_list_statuses`
  (`backend/src/mcp/server/leadReadTools.ts`). `get_lead_details` is a different projection from `manage_leads get`, not a superset: it returns
  the profile, notes, custom fields, ICP match, attribution, opt-out state, drafts, enrichment sources, the LinkedIn connection status, the
  engagement counts and the 10 most recent engagements, and it does NOT return the pipeline status or the deal value (`manage_leads get`
  does). It finds a lead whose list id is stale only when the list id itself exists and the caller can access it, and only inside lists the
  caller can access (own lists, and the organization's while CRM sharing is on). `get_lead_engagements` is the history of one lead, newest
  first, `limit` 1 to 100 (default 20); it has no stale-list recovery. `get_lead_list_statuses` returns a list's pipeline stages, including
  the default a list that never stored its own uses (which `create_lead_list get` does not show).
- Counts to read right: `engagementSummary.total` and `last7Days` count messages SENT; `totalAllMessages` counts every event. A cut page says
  so in `message` ("Showing the first N of M"); `total` is not the history size.
- Same pattern as the other wave-2 tools: the handler checks arguments by name (an unknown argument, including any identity such as
  `user_id`, `client_id`, `orgId`, is refused; `userId`, `sessionId` and `llmModel` are stripped by the MCP server before the tool sees them),
  then self-calls the `/api/emma` route as the key's own user. The list access check (`canOrgMemberAccessList`: the list owner, or a member of
  the owner's organization while the organization shares its CRM) runs in Emma's handler on the far side and is not replaced. It differs
  slightly from the CRM routes' guard (`canAccessCrmList`): with CRM sharing off an organization admin who is neither owner nor listed editor
  passes the CRM routes and is refused here; with an organization row missing, this guard allows and the CRM routes deny. Both pre-exist.
- `/api/emma/*` answers a refusal as HTTP 200 `{ success: false, message }`. The tools turn that into an error carrying only the route's
  short `message`; the route's `error` field (raw exception text on an internal failure) is dropped, and a 5xx from the route (whose catch-all
  answers with the exception's message) is replaced by a fixed text. A 4xx (a 429 for an account over its monthly quota, a 400) passes through.
  "Lead list not found" and "Access denied" are different answers, as they are for Emma and for `manage_leads get`, so a caller can tell a real
  list id of another account from an unknown one (ids are not guessable).
- Two thin routes were added for the tools that had none: `POST /api/emma/lead-engagements` and `POST /api/emma/lead-list-statuses`, both
  `metered` like `/leads` and `/lead-details` (an account over its monthly token quota is refused on them as on those).
- Not `readOnly`, on purpose. A "read" can write a cache: the first read of a lead's history fetches, for every email event of that lead that
  has no content stored yet, the content from the mail provider (all at once, with the platform's key) and stores it, whatever `limit` is; a
  fetch that fails is not stored and is tried again on the next read. `get_lead_details` can also check a connected LinkedIn account. These
  are Emma's and the portal's own costs, now reachable by an API key; the key's rate limit (60 calls a minute) and the monthly token quota are
  the only bounds. A `tools:read` key cannot call these tools (same as `manage_leads` and `search_leads`). Nothing in the lead or list changes.
  The tools are found with `emma_search_tools`, not in the default tool list.
- Known limit, inherited from `crmDb.getLeadEngagements` / `getLeadEngagementCount` and unchanged here: email events are looked up through the
  account's single legacy `emailDomain` setting. An account whose sending domain is stored only in `emailDomains[]`, or that sends from a
  connected mailbox, gets no email events from these tools (LinkedIn and hand-recorded events are always included), so an empty history is not
  proof that a lead was never emailed. The tool descriptions say so. The lookup is keyed by that domain string, not by account; a new-style
  domain is claimed by one account only, the legacy field is set by an admin without a uniqueness check. Another pre-existing flaw seen on the
  way: the LinkedIn connection lookup applies `Limit: 5` before filtering by account, so a profile that is a connection of more than five
  accounts can read as not connected.
- Not exposed here, and why: `get_hot_leads`, `get_leads_needing_followup`, `get_lead_conversation_statuses` (each reloads the whole email
  history of the account's domain on every call), `analyze_crm_data` and `ask_crm` (spend the platform's model key), `log_contact_event`
  (writes to a global table keyed by an email taken from the argument, with no ownership check).
- Still true: external answers pass through the public response sanitiser (drops any key named `ipAddress`, `userAgent`, `debug`, `telemetry`,
  `sessionId` and similar at any depth, including inside a lead's custom fields or event data, and returns `null` past 10,000 nodes), as for
  `manage_leads`.
- Proof: unit tests of the request builders, refusals, 5xx handling and descriptions (`mcp/server/__tests__/leadReadTools.test.ts`), the two
  routes against Emma's real handlers (`emmaApi.leadReadback.test.ts`), and two tenants through the real MCP server, tool, route, handler and
  in-memory database (`mcp.leadReads.twoTenant.test.ts`), including the stale-list recovery with the lists it looked in read off the database.
  The in-memory database now serves BatchGetItem (`inMemoryDynamo.batchGet.test.ts`): without it the recovery's failure was swallowed as "not
  found" and a test of it could pass without the recovery running. Not covered there: the email-event half of an engagement read
  (AW-EmailEvents is not in the fake), and Limit / ExclusiveStartKey.
