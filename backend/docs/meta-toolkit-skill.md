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
- Datasets (pixels) and conversions: `ads_get_datasets`, `ads_get_dataset_details`, `ads_get_dataset_stats`, `ads_pixel_event_read` (event rules), `ads_get_customconversions`. Pixel reads take `pixel_id` and only work for pixels in the selected ad account. If Meta refuses a read, the result has `success: false` with Meta's reason and an `errorClass`.
- With more than one connected ad account, pass `account_id`.

## Creatives: upload your own images and videos
Use this when the user has creatives made elsewhere (Higgsfield, Midjourney, Canva, a designer). You don't need Ads Manager. These calls need no preview because an asset or creative can't spend anything until an ad uses it. They still need the payment method, the Meta connection and ads management.

1. **Get the file to Meta.**
   - The file already has a public `https` URL: skip to step 2 and pass that URL.
   - The file is on the user's computer: call `zoma_prepare_upload` with `{"filename": "hero-01.png"}`, then run the returned `upload_command`, replacing the path with the real local path. It prints nothing on success. Use the returned `file_url` in step 2. Make one call per file. The upload link lasts 15 minutes.
   - Limits: images (.jpg .png .gif .webp) up to 30 MB, videos (.mp4 .mov .m4v .webm) up to 1 GB.
2. **Upload to the ad account's media library** with `call_meta_marketing_api`, `entity_type: AD_CREATIVE`:
   - Image: `action: UPLOAD_IMAGE`, `params.image_url`. This returns an `image_hash`.
   - Video: `action: UPLOAD_VIDEO`, `params.video_url`. Zoma waits for Meta to process the video and returns a `video_id` and a `thumbnail_url`. If it says `processing`, call `UPLOAD_VIDEO` again in a minute with only `params.video_id`.
3. **Build the creative.** Call `action: CREATE` with `params`: `name`, `page_id` (from `PAGE LIST`), `body` (primary text), `title` (headline), `link_url`, an optional `call_to_action_type` (e.g. LEARN_MORE, SHOP_NOW), and the media:
   - Image: `image_hash`.
   - Video: `video_id` plus a thumbnail, either `image_url: <thumbnail_url>` or an `image_hash`.
   It returns a `creative_id` once Meta reads it back (`verification: CONFIRMED`).
4. **Make the ad.** Call `AD CREATE` with `ad_set_id` and `params: {name, creative_id}`, using the normal preview and approval flow below. The ad is created PAUSED.

For a batch, repeat steps 1 to 3 for each file, then create one ad per creative. Tell the user what was created and leave everything paused.

## Writes (CAMPAIGN, AD_SET, AD)
Allowed: CREATE, and UPDATE of these fields. Not available: DELETE. Creatives are covered above; custom audiences are below.
- CAMPAIGN: `status`, `daily_budget`/`lifetime_budget`, `bid_strategy`, `spend_cap`.
- AD_SET: `status`, budgets, `bid_amount`, `bid_strategy`, `targeting` (full spec, replaces the current one, so it must include the locations, e.g. `geo_locations: {countries: ["US"]}`; use `excluded_custom_audiences: [{id}]` to exclude audiences), `start_time`, `end_time` (ISO 8601).
- AD: `status`, `name`, `creative_id` (swap in an existing creative; to change ad copy, create a new creative first, then swap it in).
Change a budget or `spend_cap` in its own UPDATE (not even with `status`), and swap a creative (`creative_id`) in its own UPDATE; Zoma refuses mixing them with other edits. On an ACTIVE ad set, a `start_time`/`end_time` change is also its own UPDATE, because it can start delivery. Times need a timezone offset (e.g. `2026-12-01T09:00:00-0800`). The UPDATE preview lists every field as current → proposed. `bid_strategy` is one of LOWEST_COST_WITHOUT_CAP, LOWEST_COST_WITH_BID_CAP, COST_CAP; `bid_amount` and `spend_cap` are major units like budgets; `bid_amount` is 0.01–1,000 (as on create) and needs a capped `bid_strategy`.

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

## Custom audiences (`zoma_custom_audiences`)
Reads (no preview): `LIST`; `GET` with `audience_id`; `LIST_AD_SETS` with `audience_id` (ad sets that include or exclude it, and whether they are active).

Writes use the same two-call preview and approval flow as other writes (call without `confirm`, show the preview, repeat with `confirm: true` and the `preview_token`):
- `CREATE` with `params.name` and a `source`:
  - `{"type": "customer_list"}` — optionally with `params.emails` / `params.phones` as the first members.
  - `{"type": "website", "pixel_id": "…", "retention_days": 30, "url_contains": "/thank-you"}` (or `event_name: "Purchase"`; up to 180 days).
  - `{"type": "engagement", "source_type": "page" | "ig_business", "source_id": "…", "retention_days": 365}`.
  - `{"type": "lookalike", "origin_audience_id": "…", "country": "US", "ratio_percent": 1}` (1–10%).
- `UPDATE` with `audience_id` and `params.name`, `params.description` or `params.rule` (website/engagement audiences).
- `ADD_USERS` / `REMOVE_USERS` with `audience_id` and `params.emails` / `params.phones` as plain text (phones with country code). Zoma normalizes and hashes them before sending; raw values are never stored or logged. Large lists are batched automatically (up to 100,000 per call).
- `DELETE` with `audience_id`. Refused while an active ad set uses the audience; repeat with `confirm_in_use: true` only if the user explicitly wants it deleted anyway.
- `EXCLUDE_CUSTOMERS` — keep prospecting ads away from existing customers in one call: `ad_set_ids` plus either `params.emails` / `params.phones` (Zoma creates or reuses a customer list named `params.name`, default "Existing customers (Zoma)") or an existing `audience_id`. The preview shows each ad set's `excluded_custom_audiences` before → after. Nothing else about the ad sets changes.

If a result says `TERMS_NOT_ACCEPTED`, give the user `terms_url` (Meta's Custom Audience Terms for that ad account), wait until they accept, then retry the same request. Audiences never spend on their own; ads that use them are created PAUSED through `AD CREATE` as usual.

## Usage
Call `zoma_usage` when the user asks what they have used this month. Billing is not enabled yet; usage is only recorded.
