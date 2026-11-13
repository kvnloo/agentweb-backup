## Smartlead tools for outside agents over MCP (ENG-673 follow-on) (2026-11-12)

Customer-facing agents (the Hermes agents: Yugo, Hue, Remy) now work in Slack and reach Emma through her MCP server. Until now none
of the Smartlead tools were on MCP. This adds the read and stop tools, on the user's own Smartlead connection.

**On MCP (same names and checks as Emma's tools):**
- `smartlead:read`: `list_smartlead_campaigns`, `get_smartlead_campaign_stats`, `preview_smartlead_push`, `get_smartlead_push_status`.
- `smartlead:control`: `pause_smartlead_push`, `cancel_smartlead_push` (stop actions: nobody receives more email).

**Not on MCP:** `start_smartlead_push`, `resume_smartlead_push`, `release_leads_from_smartlead`. They send email to real people (or let
AgentWeb's own senders email contacts again). In Emma's chat a product-built approval card stands in for the portal's lawful-basis and
"already sending" ticks; an MCP agent has no card, so it would approve its own send. The preview returns a link to the list
(`/crm?listId=`) and the steps (the list's settings menu, Push to Smartlead) where the person who owns the account approves. The signed
preview token and fingerprint never reach the agent (the result is an allowlist).

**Who may call them:** only an `aw_` key that explicitly holds the scope. New registry flag `apiKeyOnly`: a signed-in OAuth client is
refused (OAuth otherwise gets every opt-in scope, OAuth parity 2026-10-31), so marketplace OAuth clients (Databricks, ENG-2747) do not
gain them; default keys do not hold the scopes; anonymous callers are refused. The scopes cannot be granted from a delegated
(admin-as-customer) session, like `email:read`. tools/list shows the tools only to a key holding the scope (plus `list_lead_lists` for
`smartlead:read`, for the listId).

**How:** each tool self-calls the portal's own route (`/api/crm/smartlead-push/...`), so the per-user rate limits, the kill switch and
every push rule apply unchanged. New route `GET /campaigns/:campaignId/stats` (its own per-user limiter; Emma reads the service
directly). Argument checks and result shapes moved from `emma/smartleadPushTools.ts` into `services/smartleadPushToolShared.ts` so both
use one copy (no behaviour change for Emma). Each MCP call logs one `mcp_smartlead` line (tool, user, key id, outcome; no contact data).

**Review follow-ups (independent review of 6106c7d49):** the HTTP layer now refuses these tools on the request's own auth method, so an
OAuth request cannot borrow a session a key opened; `emma_search_tools` shows them only to a key that may call them; `list_lead_lists`
is marked read-only (it is a GET) so a key with `smartlead:read` can find a listId; `smartlead:control` no longer lists
`get_smartlead_push_status` (needs `smartlead:read`); when several Smartlead connections are available the error now names them so the
agent can pass `accountId` (mcpFetch keeps the route's `details`); ids made only of dots are refused; wording says "someone with
access to this list". Two older holes the review found are fixed separately (ENG-2962: agents approving Emma's cards; ENG-2963:
unescaped ids in self-call paths).

**Testing:** `mcp.smartleadTools.test.ts` (which tools exist, scopes, OAuth and anonymous refusals, tools/list, each route call, the
preview allowlist, argument checks), stats route cases in `routes/__tests__/smartleadPush.test.ts`, key-creation cases in
`agentApi.routes.test.ts`, regenerated MCP inventory (six tools added, none changed).

**Rollback:** revert; no table, IAM or environment change.
