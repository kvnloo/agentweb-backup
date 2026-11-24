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
1. Call `zoma_status`. The first time, it returns "Hey, welcome to Zoma." and one question: "How familiar are you with ads?". Say the welcome, ask the question, and call `zoma_status` again with `ads_experience` set to the answer (`runs_ads`, `new_to_ads` or `not_interested`).
2. The answer leads straight to the Meta connect link. Relay it as given; the user finishes on Zoma's own pages and comes back to you. Wait for them to say they are done.
3. Call `zoma_status` again. Repeat until it says "All set"; it then gives this guide's link and a first question to ask.
4. If the user is "just a friend" (`not_interested`), the whole answer is "Thanks for signing up and trying out Zoma." — relay it and stop.

Every tool response ends with the next step to take.

Reads work without a payment method. Changes to ads need a payment method on file and a connected Meta ad account whose connection granted ads management.

## Reporting: `zoma_ads_report`
The first tool for "how are my ads doing?". Spend, impressions, clicks, CTR, CPC, conversions and ROAS per campaign (or `level: "account"` for one total), read-only.
- Range: `date_preset` (`today`, `yesterday`, `last_7d` default, `last_14d`, `last_30d`, `last_90d`, `this_month`, `last_month`, `maximum`) or `since` + `until` (`YYYY-MM-DD`).
- Narrow with `campaign_ids`. Conversions are the account's purchases (else leads, else registrations); pass `conversion_event` to choose a Meta action type. ROAS = purchase value / spend.
- Example: `{"since": "2026-11-01", "until": "2026-11-15"}` → per-campaign rows, totals and a one-paragraph `summary`.

## Reads
- `list_meta_ads_campaigns`, `get_meta_ads_metrics`, `call_meta_ads_insights_api` for campaigns and performance.
- `call_meta_marketing_api` with LIST / GET / PREVIEW / SEARCH / GET_MATCH_QUALITY.
- Datasets (pixels) and conversions: `ads_get_datasets`, `ads_get_dataset_details`, `ads_get_dataset_stats`, `ads_pixel_event_read` (event rules), `ads_get_customconversions`. Pixel reads take `pixel_id` and only work for pixels in the selected ad account. If Meta refuses a read, the result has `success: false` with Meta's reason and an `errorClass`.
- With more than one connected ad account, pass `account_id`.

## Creatives: upload your own images and videos
Use this when the user has creatives made elsewhere (Higgsfield, Midjourney, Canva, a designer). You don't need Ads Manager. These calls need no preview because an asset or creative can't spend anything until an ad uses it. They still need the payment method, the Meta connection and ads management.

1. **Get the file to Meta.**
   - The file already has a public `https` URL (a CDN link, or the direct `.mp4` link of a UGC video): skip to step 2 and pass that URL. A link to a post page (TikTok, Instagram, YouTube) is a web page, not a file; Zoma refuses it, so download the file and use `zoma_prepare_upload`.
   - The file is on the user's computer: call `zoma_prepare_upload` with `{"filename": "hero-01.png"}`, then run the returned `upload_command`, replacing the path with the real local path. It prints nothing on success. Use the returned `file_url` in step 2. Make one call per file. The upload link lasts 15 minutes.
   - Limits: images (.jpg .png .gif .webp) up to 30 MB, videos (.mp4 .mov .m4v .webm) up to 1 GB.
2. **Upload to the ad account's media library** with `call_meta_marketing_api`, `entity_type: AD_CREATIVE`:
   - Image: `action: UPLOAD_IMAGE`, `params.image_url`. This returns an `image_hash`.
   - Video: `action: UPLOAD_VIDEO`, `params.video_url`. Zoma waits for Meta to process the video and returns a `video_id` and a `thumbnail_url`. If it says `processing`, call `UPLOAD_VIDEO` again in a minute with only `params.video_id`.
3. **Build the creative.** Call `action: CREATE` with `params`: `name`, `page_id` (from `PAGE LIST`), `body` (primary text), `title` (headline), `link_url`, an optional `call_to_action_type` (e.g. LEARN_MORE, SHOP_NOW), and the media:
   - Image: `image_hash`.
   - Video: `video_id`, optionally with your own thumbnail (`image_url` or `image_hash`); without one, Meta's processed thumbnail is used.
   - Carousel: `carousel_cards` (2–10 cards, each with its own `image_hash`, `image_url` or `video_id`, plus `title` and `link_url`). No top-level image is needed.
   - Different image per placement: `placement_assets`. No top-level image is needed.
   It returns a `creative_id` once Meta reads it back (`verification: CONFIRMED`). `MISMATCH` means Meta stored something different from what was sent: do not use that creative.

   **Multi-variant (Advantage+) creative**: one creative with several options that Meta mixes and optimizes. Pass lists instead of the single fields: `headlines` (up to 5, 255 characters each), `bodies` (up to 5), optional `descriptions` (up to 5), and media `image_hashes` and/or `video_ids` (up to 10 each), plus `name`, `page_id`, `link_url` and an optional `call_to_action_type`. Don't also pass the single field for the same thing (e.g. `title` with `headlines`). Images must be uploaded first (`image_hashes`, not URLs); videos must be processed.

   **Bulk**: `action: BULK_CREATE` builds up to 10 creatives in one call. Put the shared fields (`page_id`, `body`/`bodies`, `title`/`headlines`, `link_url`, `call_to_action_type`, `name`) in `params` and one entry per creative in `params.items`, each with its media (`image_hash`, `image_url`, `video_id`, or `video_url` for a video not uploaded yet) and any per-item overrides. Items are named `<name> 1`, `<name> 2`… unless they set `name`. Every item is reported in `results` with its own `verification`; a failed item does not undo the others. Don't re-create items that have a `creative_id`; retry only the failed ones.
4. **Make the ad.** Call `AD CREATE` with `ad_set_id` and `params: {name, creative_id}`, using the normal preview and approval flow below. The ad is created PAUSED.

For a batch, upload each file (step 1–2) or pass public URLs straight to `BULK_CREATE`, then create one ad per creative. Tell the user what was created and leave everything paused.

## Writes (CAMPAIGN, AD_SET, AD)
Allowed: CREATE, UPDATE of these fields, ARCHIVE, DELETE and COPY. Creatives are covered above; custom audiences are below.
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

### Archive, delete, copy
Pass the entity's id (`campaign_id`, `ad_set_id` or `ad_id`); same preview and approval flow as above.
- `ARCHIVE` stops delivery and keeps the entity and its history. Prefer it over `DELETE`.
- `DELETE` cannot be undone. Say so to the user before asking for approval.
- Both are refused when the entity spent in the last 24 hours (or Zoma could not check). Pause it first; only if the user explicitly accepts stopping it while it spends, repeat with `confirm_recent_spend: true` (it is part of the previewed call).
- `COPY` duplicates the entity, always PAUSED. `params.deep_copy: true` also copies a campaign's ad sets and ads (or an ad set's ads). Put an ad set copy into another campaign with `params.campaign_id`, an ad copy into another ad set with `params.adset_id`. The result's `id` is the new copy.

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

<!-- zoma-google:start -->
## Google Ads (when enabled for the account)
`call_google_ads_api` uses the same two-call preview → `confirm: true` + `preview_token` flow and the same `verification: CONFIRMED` rule. Keywords, ads and asset groups are always created PAUSED; enabling each is its own UPDATE `status: ENABLED` preview.
- **Keywords:** `KEYWORD ADD` (`ad_group_resource_name`, `keywords: [{text, matchType}]`, matchType BROAD / PHRASE / EXACT), `UPDATE` (`criterion_resource_name`, `status`), `REMOVE` (`criterion_resource_name`, permanent).
- **Negative keywords:** `KEYWORD ADD_NEGATIVE` with `keywords` and exactly one of `campaign_resource_name` or `ad_group_resource_name`.
- **Responsive search ad:** `AD CREATE` with `ad_group_resource_name`, 3–15 `headlines` (≤30 characters each), 2–4 `descriptions` (≤90 each) and an https `final_url`. Copy and URL cannot be edited later. Enable with `AD UPDATE` (`ad_resource_name`, `status`).
- **Assets:** `ASSET UPLOAD` runs without a preview, because an asset can't spend until something uses it. Use `asset_type` IMAGE or LOGO with `data` set to an https image URL or the `file_url` from `zoma_prepare_upload`, TEXT with the text as `data`, or VIDEO with a YouTube video id. It returns the asset resource name.
- **Performance Max, end to end:** (1) upload the logo (`LOGO`), the square and landscape images (`IMAGE`); (2) `BUDGET CREATE`; (3) `CAMPAIGN CREATE` with `type: PERFORMANCE_MAX`, `brand_business_name` (≤25 characters) and `brand_logo_asset_resource_name`; (4) `ASSET_GROUP CREATE` with `name`, `campaign_resource_name`, `final_url`, 3–15 `headlines` (≤30), 1–5 `long_headlines` (≤90), 2–5 `descriptions` (≤90, at least one ≤60), `square_image_assets`, `landscape_image_assets`, and optionally `logo_assets` / `video_assets`; (5) `ASSET_GROUP UPDATE status: ENABLED`, then `CAMPAIGN UPDATE status: ENABLED`, each with its own approval.
<!-- zoma-google:end -->
<!-- zoma-linkedin:start -->

## LinkedIn Ads (when enabled for the account)
`linkedin_ads_read` reads the connected LinkedIn ad account and changes nothing: `LIST_ACCOUNTS`, `LIST_CAMPAIGN_GROUPS`, `LIST_CAMPAIGNS` (optionally one `campaign_group_id`), `LIST_CREATIVES` (`campaign_id`), `LIST_TARGETING_FACETS`, `SEARCH_TARGETING_ENTITIES` (`facet_urn`, `query`), `ESTIMATE_AUDIENCE` (`targeting_include`) and `GET_ANALYTICS` (`pivot`, `start_date`, `end_date`; LinkedIn's adAnalytics). Money is in the account currency in major units.
- **What works for which ad account:** reporting (`GET_ANALYTICS`) works for every connected ad account. For an ad account LinkedIn has not enabled for the Zoma app yet, the other reads can come back as `ad_account_not_enabled`: say so plainly, and offer reporting instead. Never guess at the missing data.
- **If a result says `rate_limited`:** LinkedIn (or Zoma's per-minute limit) asked to slow down. Wait `retry_after_seconds`, then try once; do not retry in a loop.
<!-- zoma-linkedin-writes:start -->
- **Changes:** `linkedin_ads_write` uses the same two-call preview → `confirm: true` + `preview_token` flow and the same `verification: CONFIRMED` rule. Campaign groups, campaigns and creatives are always created `DRAFT` and never go live; going live is `ACTIVATE`, its own preview and approval, checked against the daily budget it unlocks. Every value is sent as you give it (name, campaign type, objective, cost type, bid, daily budget, schedule, locale, political intent, targeting): ask the user for each one, because nothing is defaulted. Order: `CAMPAIGN_GROUP CREATE`, then `CAMPAIGN CREATE` with its `campaign_group_id`, then `CREATIVE CREATE` with the `campaign_id` and a `post_urn` (or a text ad), then `ACTIVATE` each.
- **Zoma's safety limit (USD accounts only for now):** a campaign's daily budget is at most $50, one change may raise a budget by at most 2x (lowering a budget is always allowed), and a total (lifetime) budget is at most $1,500. An ad account in any other currency is refused until Zoma enables it. A refusal says what the limit is and who changes it: tell the user, suggest asking Zoma support (support@agentweb.pro), and never split a change into smaller ones to get around it.
- **Only for ad accounts LinkedIn has enabled for the Zoma app:** for any other ad account the result says write access is not enabled for it yet and nothing was changed; reading and reporting still work. Tell the user that; do not retry.
- **Read-back is conservative:** `CONFIRMED` only when LinkedIn's own answer shows the change. `UNCONFIRMED` means Zoma could not tell (no answer, a failed read, an unexpected shape): re-read with `linkedin_ads_read` before doing anything again, so nothing is created twice.
<!-- zoma-linkedin-writes:end -->
<!-- zoma-linkedin:end -->

## Usage
Call `zoma_usage` when the user asks what they have used this month. Billing is not enabled yet; usage is only recorded.
