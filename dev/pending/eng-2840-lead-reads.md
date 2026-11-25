## ENG-2840: Lead reads for outside agents over MCP (2026-11-25)

- Three tools that Emma has now exist on the MCP server: `get_lead_details`, `get_lead_engagements`, `get_lead_list_statuses`
  (`backend/src/mcp/server/leadReadTools.ts`). `get_lead_details` is a different projection from `manage_leads get`, not a superset: it returns
  the profile, notes, custom fields, ICP match, attribution, opt-out state, a message draft and a 200-character preview of the email draft,
  enrichment sources, the LinkedIn connection status (`isConnected: false` also means "could not check": errors are swallowed), the
  engagement counts and the 10 most recent engagements. It does NOT return the lead's own pipeline status or deal value fields, nor website,
  domain, role, lifecycle, priority, heat score, expected close date and similar stored fields (`manage_leads get` does); status changes and
  deal values DO appear inside engagement events (`status.changed` events carry from, to, dealValue). The history is not only emails and
  hand-recorded notes: `lead.engagements` also holds contact-status audit events (with `actorUserId`, and `delegatedByUserId` for staff
  acting by delegation: both pass the public sanitiser, as they do on the portal's own route), LinkedIn invite events, hot-lead call events and
  Smartlead events (replies, bounces and opt-outs only: no bodies, and never the emails Smartlead sent). LinkedIn messages are read from the
  event table under `linkedin-<listId>`, for a lead with a LinkedIn URL; the email events come from the same table under the caller's domain. `get_lead_engagements` is the history of
  one lead, newest first, `limit` 1 to 100 (default 20).
- NO stale-list search over MCP (decision after review round 3). Emma's `get_lead_details` looks for a lead that is not in `list_id` in the
  caller's other accessible lists (ENG-969): the caller's lists, then one query per organization member, then up to 8 batched reads per tier,
  retried once after 300 ms on an error. `AW-LeadLists` is provisioned at 5 read units and its `userId-index` at 5 (read-only
  `describe-table`, 2026-11-25; 412 items), so a key that can repeat that for any unknown lead id 60 times a minute (600 for a key created
  with the maximum) could throttle the lead-list reads of every tenant. The tool sends `recover_stale_list: false` and an unknown lead id is
  refused as "Lead not found" with no per-member list queries (the list read, the access check and one lead read). Emma, the portal and the readback verifier send nothing and keep the search. The
  route takes `recover_stale_list` as a boolean (anything else is a 400); only `false` changes behaviour.
  `get_lead_list_statuses` returns a list's pipeline stages, including the default a list that never stored its own uses (which
  `create_lead_list get` does not show); it only reads, so it is `readOnly` and a `tools:read` key can call it.
- Counts to read right: `engagementSummary.total` and `last7Days` count events whose type contains "sent" (sent messages, but also
  `linkedin.invite_sent` and any type containing "consent"); `totalAllMessages` counts every event (LinkedIn events are de-duplicated first). A cut page says
  so in `message` ("Showing the first N of M"). When counting fails the data layer returns zeros and the answer still says `success`: three
  zero counts beside listed events mean the count failed (the `engagementCountUnavailable` flag the handler has for this can never fire,
  because `getLeadEngagementCount` swallows its own errors; pre-existing).
- Same pattern as the other wave-2 tools: the handler checks arguments by name (an unknown argument, including any identity such as
  `user_id`, `client_id`, `orgId`, is refused; `userId`, `sessionId` and `llmModel` are stripped by the MCP server before the tool sees them),
  then self-calls the `/api/emma` route as the key's own user. The list access check (`canOrgMemberAccessList`: the list owner, the
  organization's owner and listed CRM editors, and any other member of the owner's organization while the organization shares its CRM) runs
  in Emma's handler on the far side and is not replaced. It differs slightly from the CRM routes' guard (`canAccessCrmList`): with CRM sharing
  off an organization admin who is neither owner nor listed editor passes the CRM routes and is refused here; with an organization row
  missing, this guard allows and the CRM routes deny. Both pre-exist.
- `/api/emma/*` answers a refusal as HTTP 200 `{ success: false, message }`. The tools turn that into an error carrying only the route's
  short `message`; the route's `error` field (raw exception text on an internal failure) is dropped. A 5xx from the route (its catch-all
  answers with the exception's message) and a failure to reach the route (the raw message names the internal route and port) are replaced by
  a fixed text. A 4xx (a 429 for an account over its monthly quota, a 400) passes through with the route's own words. "Lead list not found"
  and "Access denied" are different answers, as they are for Emma and `manage_leads get`, so a caller can tell a real list id of another
  account from an unknown one; list ids look like `list_<time>_<random>` and are not guessable, except the Calendly list, whose id contains
  the owner's user id.
- Two thin routes were added for the tools that had none: `POST /api/emma/lead-engagements` and `POST /api/emma/lead-list-statuses`, both
  `metered` like `/leads` and `/lead-details`. `metered` means an account that is already over its monthly token quota is refused on them;
  these reads spend no tokens, so the quota does NOT bound how often they run. The bounds are the key's rate limit (60 calls a minute by
  default; a key can be created with 1 to 600; several keys of one account multiply it) and the fetch bound below.
- Cost of a history read. `crmDb.getLeadEngagements` fetches the body of every received or delivered email event that has no stored body from
  the mail provider (Resend, with the platform's key; two provider calls per received event, with retries) and stores it as a cache. Emma and
  the portal do this for every such event at once, whatever `limit` is. A failed fetch is not stored and is tried again on the next read. The
  provider fetch path is not paced like sending (sends go out at most 2 a second). For the MCP tools the data layer takes an allowance
  (`options.maxContentFetches`, sent by the tools as 10; the routes take `max_content_fetches`, a whole number 0 to 50, and answer 400 to
  anything else, so a bad value is never a silent "no cap"): only the newest 10 such events without a stored body are fetched per call, through
  ONE chain for the whole process (`runCappedFetch` in `services/db.ts`): one at a time, 500 ms apart (the gap the platform's own sends keep),
  at most 20 waiting; a fetch that would wait behind more is skipped and its event comes back without a body. An uncapped read (Emma, the
  portal) does not use the chain and runs every fetch at once, as before. Resend's limit is shared with the platform's sends and the chain
  paces only these fetches: it cannot guarantee that fetches plus sends stay under that limit, it stops a key's reads from adding a burst.
  The other events come back without a body. A body already stored never uses the
  allowance, and a body that cannot be fetched is not remembered: it uses the allowance again on every call, so a lead whose 10 newest bodies
  fail never reaches older ones. Emma and the portal send nothing and are unchanged. `limit` does not bound reading: the email events of the
  lead's address are read in full (twice, count and list) before the page is cut. `get_lead_details` can also check a connected LinkedIn
  account (Unipile), one probe per connected account when the list names none and the user has more than one; the connection lookup is by the
  list's LinkedIn account when the list names one, else by the CALLER's account.
- Known limit, inherited from `crmDb.getLeadEngagements` / `getLeadEngagementCount` and unchanged here: email events are looked up through the
  CALLING account's single legacy `emailDomain` setting, not the list owner's (an organization member reading a shared list sees only emails
  under their own domain). An account whose sending domains are stored only in the multi-domain setting (`emailDomains[]`), or that sends from
  a connected mailbox, gets none of its own emails from these tools (Smartlead emails, LinkedIn events and hand-recorded events live on the
  lead and are included; LinkedIn events only for a lead with a LinkedIn URL), so an empty history is not proof that a lead was never
  emailed. The lookup is keyed by that domain string, not by account;
  a new-style domain is claimed by one account only, the legacy field is set by an admin without a uniqueness check. Another pre-existing
  flaw seen on the way: the LinkedIn connection lookup applies `Limit: 5` before filtering by account, so a profile that is a connection of
  more than five accounts can read as not connected. The Resend content fetch sets no timeout.
- Not `readOnly` (the two lead tools): a read can write the content cache. A `tools:read` key cannot call them (same as `manage_leads` and
  `search_leads`). Nothing in the lead or list changes. They are found with `emma_search_tools`, not in the default tool list.
- Not exposed here, and why: `get_hot_leads`, `get_leads_needing_followup`, `get_lead_conversation_statuses` (each reloads the whole email
  history of the account's domain on every call), `analyze_crm_data` and `ask_crm` (spend the platform's model key), `log_contact_event`
  (writes to a global table keyed by an email taken from the argument, with no ownership check).
- Still true: external answers pass through the public response sanitiser (drops any key named `ipAddress`, `userAgent`, `debug`, `telemetry`,
  `sessionId` and similar at any depth, including inside a lead's custom fields or event data, and returns `null` past 10,000 nodes), as for
  `manage_leads`; the descriptions say so. Email text and notes are third-party content: the descriptions tell agents to treat them as data.
- Proof: unit tests of the request builders, refusals, error texts and descriptions (`mcp/server/__tests__/leadReadTools.test.ts`), the two
  routes against Emma's real handlers and the allowance's path to the data layer (`emmaApi.leadReadback.test.ts`), the allowance itself
  (`crm.db.test.ts`, `getLeadEngagements`: also the chain across concurrent reads, its pacing and its backlog limit), and two tenants through the real MCP server, tool, route, handler and in-memory database
  (`mcp.leadReads.twoTenant.test.ts`): foreign lists and lead ids, identity arguments, organization members with sharing on and off, the
  organization owner and a listed editor with sharing off, what a page holds, and that no other list is ever looked in for a lead asked for
  through the wrong list (the lists asked for are read off the database). The in-memory database now serves BatchGetItem
  (`inMemoryDynamo.batchGet.test.ts`): without it any such search's failure was swallowed as "not found" and a test could pass without the
  search running or not running. Not covered there: the email-event half of an engagement
  read (AW-EmailEvents is not in the fake), Limit / ExclusiveStartKey, BatchGetItem's 100-key cap and unprocessed keys.
