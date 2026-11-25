## ENG-2840: Eight account reads for outside agents over MCP (2026-11-25)

- Eight tools that Emma has now exist on the MCP server (`backend/src/mcp/server/accountReadTools.ts`): `list_connected_account_posts`,
  `load_connected_account_metrics`, `get_post_analytics` (a connected LinkedIn or Instagram account), `search_user_guide` (the public docs),
  `get_user_profile` (the key's own email, display name, company name, plan), `get_ads_thresholds` (the caller's own Meta ad account),
  `get_hot_lead_call_settings` and `get_lead_notification_settings` (organization settings). Same pattern as the lead reads: arguments checked
  by name and by value, then the portal's own route as the key's own user (`search_user_guide` and `get_user_profile` are in-process), a
  refusal is an error carrying only a short text, a 5xx or an unreachable service is a fixed text, a 4xx passes through.
- Social reads cost something the others do not. Each can go live to LinkedIn or Instagram with the ACCOUNT OWNER's OAuth token (a plain
  organization member reading a teammate's shared page uses the teammate's token, as in the portal), may refresh and store that token, and may
  cache posts. The LinkedIn app quota is shared by every tenant; the portal throttles the same call per account (`routes/socialPosts.ts`),
  Emma's tool and the `/api/emma` routes do not. Through MCP a call goes through `socialReadGuard`: an answer is kept 60 s per (caller, tool,
  arguments) (a refusal or failure is never kept; an `success: true` answer that is empty because the provider call failed IS kept for the 60 s;
  two identical calls at the same moment both go upstream; the memory is per caller, so one tenant's answer never serves another), and each
  caller has an allowance of 30 provider-call units a minute per account across the three tools, each call costing what it can cost the provider:
  posts 1 (plus 5 per post with metrics: a personal LinkedIn post with metrics is up to five calls), account metrics 4 (a LinkedIn company page is four calls), post analytics 5 per post (a personal
  LinkedIn post is five sequential calls; at most 5 posts per call). An answer from memory costs nothing; a call that does not fit is refused
  with the seconds to wait. The budget is per caller, not per account: members of one organization reading the owner's shared page each have
  their own; one user's several keys share one allowance and there is no cap across callers. Inputs are bounded in the handler: `limit` 1 to 50 (default 10; with `include_metrics` at most 5, because a personal LinkedIn post with metrics is up to five provider calls), `include_metrics` default false (Emma's own tool defaults to true although its schema says false), `force_reload` is not an
  input, dates `YYYY-MM-DD`, real, both or neither, at most 366 days (the range ends at 00:00 UTC of `end_date`), `post_ids` 1 to 5 distinct ids of
  the shapes the posts tool hands out (a LinkedIn urn, an Instagram media number, a YouTube video id: Instagram puts the id into a Graph path; an
  invented single path word of 11 characters still matches the YouTube shape and reaches one Graph path segment, bounded by the units), and
  account and post ids refuse zero-width and bidirectional embedding/override characters (not the isolates U+2066-2069 or tag characters: the
  account id is only compared exactly and never echoed). A personal LinkedIn profile shows only the posts created through AgentWeb (plus a long
  instruction-style message addressed to Emma); `get_post_analytics` omits LinkedIn company-page posts the provider does not return. They are not `readOnly`
  (policy 'write', need `tools:execute`). The other five are read-only, so a `tools:read` key (and an OAuth client) can call them, including the
  two settings reads (the owner/admin rule is enforced on the route, whatever the key's scope). The routes themselves are unchanged and keep their token-budget class (`exempt` for the two GET
  routes, as before).
- Org settings: `get_lead_notification_settings` has a new thin route, `GET /api/emma/lead-notification-settings` (class `exempt`: a
  settings read), that requires `org:configure`. Emma's own read has no role check, so any member of an organization can read its Slack channel
  id and mentioned Slack user ids; the MCP tool is stricter on purpose, like `get_hot_lead_call_settings` (owner/admin enforced in its service;
  its revision hash is dropped). Emma's tool is unchanged (both now call the same `readLeadNotificationSettings`).
- `get_ads_thresholds` self-calls `GET /api/ads-thresholds/meta/:accountId`, whose ownership check is the caller's OWN connected Meta ad
  accounts (the store key is not user-scoped, so that check is the tenant fence). Accounts shared by a teammate are not found (as in the
  portal). The account id must be the numeric id (`act_` allowed): names are not matched, unlike Emma's own tool.
- `search_user_guide` has no tenant data; its query is limited to 500 characters in the handler (the schema limit is not enforced on the MCP
  path), and a docs outage is a fixed text (no Notion fallback: its content is not known to be public). `get_user_profile` is largely covered by
  `get_account_status`; the new fields are the display name and company name.
- NOT exposed, and why: `get_website_analytics`, `get_ga4_key_events`, `get_seo_metrics`. The GA4 property id and the Search Console domain
  are saved with a format check only (`routes/seo.ts`, `analyticsConfigValidator.ts`), with no proof that the customer owns them, and are read
  through the platform's shared Google service account; a research read of the code also found that deploying a landing page to a managed
  subdomain adds the platform's own shared property and domain to the user's config (`services/v0Service.ts`), and the readers filter by an
  exclude list, so another tenant's pages and queries could come back (code path read, not production data). That is a portal and Emma issue
  today, which exposing it over MCP would widen: it needs an ownership proof first. Also not exposed: `search_ads_knowledge_base` (discovery
  spends platform Foreplay credits, 1 per ad, up to 20 per call, no budget, and the platform key is the silent fallback), `account_summary`
  (full-account scans, up to 20 model calls and live social calls per request), `get_clarity_metrics` (configured ids and links only).
- Proof: unit tests of every request builder, refusal, error text and the guard (`mcp/server/__tests__/accountReadTools.test.ts`), and two
  tenants through the real MCP server, tool, route and handler with the provider-facing posts service as the only double
  (`mcp.accountReads.twoTenant.test.ts`): a foreign account id is refused by the real resolver before any provider call, a shared teammate
  account is reachable only once shared and with the owner's token, the memory is per caller, a plain member is refused both settings reads,
  and another tenant's ad account id is a 403. Not covered: the provider calls themselves, and an owner's own settings where the fake database
  holds no plan or billing data.
