# Zoma — Meta ads tools for your agent (AgentWeb)

Zoma lets your agent read and change Meta ads safely. Route Meta ad work through these tools; do not call the Marketing API directly.

MCP server: `https://api.agentweb.pro/api/meta-toolkit/mcp` (Streamable HTTP). It accepts a Zoma token (below) or MCP OAuth.

## "Get set up with Zoma" — do the whole setup yourself
When the user asks to get set up with Zoma, run this flow. Only relay links; never ask the user to copy tokens or edit config.

1. `curl -s -X POST https://api.agentweb.pro/api/zoma/setup`
   → `{device_code, user_code, verification_uri, verification_uri_complete, interval, expires_in}`.
   Keep `device_code` to yourself. Give the user `verification_uri_complete` and say the code is `user_code`: they sign in (or sign up) with AgentWeb and approve.
2. Poll every `interval` seconds:
   `curl -s -X POST https://api.agentweb.pro/api/zoma/setup/poll -H 'Content-Type: application/json' -d '{"device_code":"<device_code>"}'`
   - `authorization_pending` (with `next_step: sign_in`): the user has not approved yet; keep polling.
   - `slow_down`: you polled too fast; use the returned `interval` from now on.
   - `next_step: connect_meta` or `add_payment` with a `link`: relay the link once (connect the Meta ad account / add a payment method — nothing is charged), then keep polling. Relay a step's link only when the step changes.
   - `next_step: complete` with `access_token` and `mcp_url`: done. The token is shown **once** — register it immediately (step 3).
   - `expired_token`, `access_denied` or `invalid_grant`: stop and start again from step 1 if the user still wants to.
3. Register the MCP server yourself with the token:
   - Claude Code: `claude mcp add --transport http zoma <mcp_url> --header "Authorization: Bearer <access_token>"`
   - Codex: `codex mcp add zoma --url <mcp_url> --bearer-token-env-var ZOMA_TOKEN`, with `ZOMA_TOKEN=<access_token>` exported in the environment Codex runs in.
   - No MCP support: call the toolkit over plain HTTPS with the same header —
     `GET https://api.agentweb.pro/api/meta-toolkit/tools` and
     `POST https://api.agentweb.pro/api/meta-toolkit/tools/<name>/call` with body `{"args": {...}}`.
4. Call `zoma_status` to confirm, then tell the user they are set up.

To revoke a token: `curl -s -X POST https://api.agentweb.pro/api/zoma/token/revoke -H "Authorization: Bearer <access_token>"`.

Alternative (no token): `claude mcp add --transport http zoma https://api.agentweb.pro/api/meta-toolkit/mcp` or
`codex mcp add zoma --url https://api.agentweb.pro/api/meta-toolkit/mcp`; the first connection opens the AgentWeb login in the browser.

## Setup status (each step is verified by a tool — never assume)
1. Call `zoma_status`. It shows a checklist and the single next step with a link.
2. Relay the link (add a payment method, then connect Meta). Wait for the user to say they are done.
3. Call `zoma_status` again. Repeat until it says "All set".

Reads work without a payment method. Changes to ads need a payment method on file and a connected Meta ad account whose connection granted ads management.

## Reads
- `list_meta_ads_campaigns`, `get_meta_ads_metrics`, `call_meta_ads_insights_api` for campaigns and performance.
- `call_meta_marketing_api` with LIST / GET / PREVIEW / SEARCH / GET_MATCH_QUALITY.
- With more than one connected ad account, pass `account_id`.

## Writes (CAMPAIGN, AD_SET, AD only)
Allowed: CREATE, and UPDATE of `status` (ACTIVE or PAUSED) or budget. Not available: DELETE, creatives, custom audiences, uploads.

Every write is two calls to `call_meta_marketing_api`:
1. Call WITHOUT `confirm`. Nothing changes. You get a PREVIEW and a `preview_token`.
2. Show the preview to the user. Only after they explicitly approve, repeat the exact same call with `confirm: true` and that `preview_token` (single use, 15 minutes). If the result is `PREVIEW_MISMATCH`, something changed — show the new preview and ask again.

Rules:
- New campaigns, ad sets and ads are always created PAUSED.
- Going live is its own change: UPDATE `status: ACTIVE`, with its own preview and approval. Do not combine it with a budget change.
- CAMPAIGN CREATE needs an explicit `objective` (e.g. OUTCOME_LEADS, OUTCOME_SALES); it cannot be changed later, so ask the user.
- Budgets are in MAJOR units of the ad account currency (50 = $50.00; for TWD/JPY, 500 = NT$500 / ¥500). The preview echoes the converted amount — read it back to the user.
- A write is done only when the result says `verification: CONFIRMED`. `UNCONFIRMED` or `MISMATCH` is not success: tell the user and check the entity before retrying.
- If a write is refused for a missing payment method or Meta connection, call `zoma_status` and relay its link.

## Usage
Call `zoma_usage` when the user asks what they have used this month. Billing is not enabled yet; usage is only recorded.
