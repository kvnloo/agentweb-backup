# Meta Ads / Facebook Marketing API Contract

Last derived from code: 2026-06-11

Primary risk: Meta payloads look simple but fail on exact account, ID, unit,
creative, and placement semantics. Future coding agents must not infer these
from memory.

## Agent Summary

AgentWeb has two Meta Ads paths:

1. Modern path: `connected_accounts` entries with `platform` `meta` or
   `facebook`, `config.account_type` `ad_account`, and an OAuth access token.
2. Legacy path: `user.adAccount` plus centralized Secrets Manager token.

Do not remove either path without a migration plan. Multiple shipped fixes were
about choosing the correct account source.

Meta ad management is exposed through Emma tools and AgentMode wrappers. Payload
validation happens in `AgentModeService` before `MetaService` calls the Facebook
Business SDK or Graph API. Treat those validators as the local contract.

## What AgentWeb Uses Meta For

| Capability | Supported? | Entry point | Notes |
| --- | --- | --- | --- |
| OAuth / account connect | Yes | `backend/src/routes/metaAuth.ts` | Marketing flow stores ad accounts. Instagram flow stores IG business accounts separately. |
| List ad accounts | Yes | `metaService.getAdAccounts` | Called during OAuth finalize. |
| List pages | Yes | `metaService.getPages`, `AgentModeService.listMetaPages` | Page ID is required for ad creatives. |
| Campaign CRUD | Yes | `AgentModeService.manageMetaAdsCampaigns`, `metaService.createCampaign` | Uses modern connected account path with legacy fallback. |
| Ad set CRUD | Yes | `AgentModeService.manageMetaAdsAdSets`, `metaService.createAdSet` | AgentMode validates budget, schedule, targeting, objective/goal/billing compatibility. |
| Creative create/list | Yes | `AgentModeService.manageMetaAdsAdCreatives`, `metaService.createAdCreative` | Supports image, video, carousel, and placement-customized image creatives. |
| Ad CRUD/copy | Yes | `AgentModeService.manageMetaAdsAds`, `metaService.createAd` | Creative swap must be nested under `creative`. |
| Custom audiences | Yes | `AgentModeService.manageMetaCustomAudiences`, `metaService.createCustomAudience` | Supports list/create/upload users. |
| Targeting search | Yes | `AgentModeService.searchAdTargeting`, `metaService.searchTargeting` | Requires `q` and `type`. |
| Insights | Yes | `AgentModeService.callMetaAdsInsightsApiWrapper` | Async reporting with polling and paginated result fetch. |
| Quick campaign metrics | Partial / legacy | `AgentModeService.getMetaAdsMetrics` | Still requires `user.adAccount`; does not use `getMetaCredentials`. |
| Pixels/datasets/EMQ | Yes | `AgentModeService.manageMetaDatasets`, `metaService.listPixels/listDatasets/getDatasetEventStats` | Used for event match quality checks. |

## Code Pointers

| Area | Path | Purpose |
| --- | --- | --- |
| OAuth/config | `backend/src/config/integrations.ts` | Meta Graph version, OAuth URLs, marketing scopes, Instagram scopes. |
| OAuth routes | `backend/src/routes/metaAuth.ts` | Init/finalize/connect ad accounts/connect Instagram. |
| Legacy Meta route | `backend/src/routes/meta.ts` | Older account status and ad-performance route with legacy fallback. |
| V2 Meta route | `backend/src/routes/metaV2.ts` | Connected-account image ad creation and account/campaign/adset helper APIs. |
| Stored account types | `backend/src/services/connectedAccountsDb.ts` | `MetaAdAccountConfig`, `MetaPageConfig`, `MetaInstagramBusinessConfig`. |
| Meta service | `backend/src/services/metaService.ts` | SDK/Graph calls, validators, image upload/resize, creative/ad payload builders. |
| Agent wrapper | `backend/src/services/agentModeService.ts` | `getMetaCredentials`, management wrappers, validation, insights wrapper. |
| Emma tools | `backend/src/emma/tools.ts` | LLM-visible tool descriptions and input schema. |
| Constants | `backend/src/utils/metaConstants.ts` | Allowed insight fields/breakdowns/date presets and objective/goal/billing maps. |
| Fetch utility | `backend/src/utils/metaApiFetch.ts` | Retry and pagination helper for Graph API fetches. |
| Meta types | `backend/src/types/meta.ts` | Account/page/token interfaces. |

## Stored Internal Shape

Modern Meta ad accounts are stored on the user as connected accounts:

```ts
{
  platform: "meta", // older records may use "facebook"
  account_id: "123456789", // numeric string, no act_ prefix
  account_name: "Business Name",
  config: {
    account_type: "ad_account",
    ad_account_id: "123456789", // numeric string, no act_ prefix
    currency: "USD",
    account_status: 1,
    access_token: "...",
    token_expires_at: 1780000000000,
    scopes: ["ads_management", "ads_read", "pages_show_list"]
  }
}
```

Instagram Business accounts are separate records:

```ts
{
  platform: "instagram",
  account_id: "1784...",
  account_name: "brand_handle",
  config: {
    account_type: "instagram_business",
    instagram_account_id: "1784...",
    username: "brand_handle",
    access_token: "...",
    token_expires_at: 1780000000000,
    scopes: [
      "instagram_business_basic",
      "instagram_business_content_publish",
      "instagram_business_manage_insights"
    ]
  }
}
```

Legacy Meta setup still exists:

```ts
{
  adAccount: "123456789" // or sometimes "act_123456789"; code strips act_
}
```

The legacy path uses `getMetaAccessToken()` from Secrets Manager.

## Account Resolution Contract

Use `AgentModeService.getMetaCredentials(userId, accountId?)` for Meta Ads
management and insights unless the code explicitly documents a legacy-only path.

Resolution order:

1. Load `user.connected_accounts`.
2. Keep accounts where:
   - `platform` is `meta` or `facebook`.
   - `config.account_type` is `ad_account`.
   - `config.access_token` exists.
3. If no connected account exists, fall back to `user.adAccount` and
   `getMetaAccessToken()`.
4. If an `account_id` is provided, match it after stripping `act_`.
5. If multiple connected accounts exist and no `account_id` is provided, return
   a user-facing ambiguity error.
6. Reject expired connected-account tokens.

Important: agent tools should get `account_id` from `list_connected_accounts`.
They should not guess account IDs.

## OAuth Contract

Marketing OAuth:

- Config lives in `INTEGRATION_CONFIG.meta`.
- Default API version is `process.env.META_API_VERSION || "v25.0"`.
- Scopes requested for marketing are:
  - `ads_management`
  - `ads_read`
  - `pages_show_list`
- `/api/oauth/meta/finalize` exchanges code for token and lists ad accounts.
- `/api/oauth/meta/connect-ad-accounts` stores selected ad accounts.

Instagram OAuth:

- Uses Instagram Business Login endpoints, not Facebook Login endpoints.
- Scopes requested are:
  - `instagram_business_basic`
  - `instagram_business_content_publish`
  - `instagram_business_manage_insights`
- Stores `platform: "instagram"` and `account_type: "instagram_business"`.

Do not combine marketing and Instagram account records unless the auth model is
explicitly redesigned.

## Agent Tool Contract

### `list_meta_ads_campaigns`

Purpose: list campaigns for the current user.

Current behavior:

- Delegates to `agentModeService.listMetaAdsCampaignsNew`.
- Uses connected accounts and legacy fallback through `getMetaCredentials`.
- The tool schema has no input fields.

Use this first when an agent needs campaign IDs for metrics or updates.

### `call_meta_marketing_api`

Purpose: manage Meta Ads entities.

Supported entity/action matrix:

| Entity | Actions |
| --- | --- |
| `CAMPAIGN` | `LIST`, `CREATE`, `UPDATE`, `DELETE` |
| `AD_SET` | `LIST`, `CREATE`, `UPDATE`, `DELETE` |
| `AD_CREATIVE` | `LIST`, `CREATE`, `UPLOAD_IMAGE`, `UPLOAD_VIDEO` |
| `AD` | `LIST`, `CREATE`, `UPDATE`, `DELETE`, `COPY_AD` |
| `CUSTOM_AUDIENCE` | `LIST`, `CREATE`, `UPLOAD_USERS` |
| `TARGETING` | `SEARCH` |
| `PAGE` | `LIST` |
| `DATASET` | `LIST`, `GET_MATCH_QUALITY` |

Required IDs:

| Action | Required IDs |
| --- | --- |
| Campaign update/delete | `campaign_id` |
| Ad set create | `campaign_id` |
| Ad set update/delete | `ad_set_id` |
| Ad create | top-level `ad_set_id` plus `params.creative_id` |
| Ad update/delete/copy | `ad_id` |
| Dataset match quality | `params.dataset_id` |

### `call_meta_ads_insights_api`

Purpose: custom reporting query.

Contract:

- Requires `account_id`, `object_type`, and `fields`.
- `object_type` must be one of `account`, `campaign`, `adset`, `ad`.
- Non-account object types require `object_id`.
- `fields`, `breakdowns`, `action_breakdowns`, `date_preset`, and `level` are
  allowlisted in `backend/src/utils/metaConstants.ts`.
- `date_preset` and `time_range` are mutually exclusive.
- `time_range` dates must use `YYYY-MM-DD`.
- The wrapper submits an async insights job, polls for completion, then follows
  pagination.
- Results return inline as `{ success, totalRows, metadata, data }`. Oversized
  tool responses are handled by the general tool pipeline, not custom S3 upload.

### `get_meta_ads_metrics`

Purpose: quick prebuilt dashboard summary for campaign IDs.

Current gap:

- This path still checks `user.adAccount` directly and fetches token via
  `getMetaAccessToken`.
- It does not currently use `getMetaCredentials`.
- Do not describe this as fully connected-account compatible until migrated.

## External Payload Contract

### Account IDs

- Internal ad account IDs should be stored and passed without `act_`.
- SDK/Graph request builders add `act_` when addressing an ad account node.
- Matching code should strip `act_` before comparing.

### Campaign Create

Internal params:

```ts
{
  name: string,
  objective: string,
  status?: string,
  special_ad_categories?: string[],
  advantage_campaign_budget?: boolean,
  budget_amount?: number // dollars, converted to cents for campaign daily_budget
}
```

Allowed objectives in current validators:

- `OUTCOME_TRAFFIC`
- `OUTCOME_AWARENESS`
- `OUTCOME_ENGAGEMENT`
- `OUTCOME_SALES`
- `OUTCOME_LEADS`
- `OUTCOME_APP_PROMOTION`

Current service behavior:

- Default status is `PAUSED`.
- `special_ad_categories` filters out `NONE` and empty strings before sending.
- Sets `is_adset_budget_sharing_enabled: false`.
- If `advantage_campaign_budget` and `budget_amount` are provided, sends
  `daily_budget = Math.round(budget_amount * 100)`.

### Ad Set Create

Internal params:

```ts
{
  name: string,
  campaign_id: string,
  daily_budget?: number, // dollars in AgentMode, cents in MetaService
  lifetime_budget?: number, // dollars in AgentMode, cents in MetaService
  start_time?: string,
  end_time?: string,
  billing_event: string,
  optimization_goal: string,
  bid_strategy?: string,
  bid_amount?: number, // dollars in AgentMode, cents in MetaService
  targeting: object,
  status?: string,
  promoted_object?: object
}
```

AgentMode validation rules:

- Fetch campaign first to determine objective and whether campaign-level budget
  already exists.
- If the campaign has Advantage Campaign Budget, strip ad-set budgets.
- Otherwise exactly one of `daily_budget` or `lifetime_budget` is required.
- `lifetime_budget` requires `end_time`.
- Lifetime budget duration must be at least 24 hours.
- Minimum budget is `$1.00`.
- Safety caps:
  - daily budget <= `$5,000`
  - lifetime budget <= `$50,000`
  - bid amount <= `$1,000`
- `targeting.geo_locations` is required and must include at least one of
  `countries`, `regions`, `cities`, or `zips`.
- Empty geo arrays are invalid.
- `targeting.age_min` must be >= 18.
- `targeting.age_max` must be <= 65.
- `targeting_automation.advantage_audience` is auto-injected as `0` if omitted.
- AgentMode converts dollars to cents before calling `MetaService.createAdSet`.

Compatibility maps live in `backend/src/utils/metaConstants.ts`:

- `META_OBJ_GOAL_MAP`
- `META_GOAL_BILLING_MAP`
- `META_GOAL_BID_STRATEGY_MAP`

Note: comments in `metaConstants.ts` mention Meta v24 while runtime defaults
elsewhere use `v25.0`. Treat this as a doc drift warning; verify compatibility
against the current vendor version before expanding the matrix.

### Creative Create

Common required fields:

```ts
{
  name: string,
  page_id: string,
  body: string
}
```

Non-carousel creatives also require:

```ts
{
  title: string,
  link_url: string
}
```

Exactly one creative type should be used:

| Type | Required shape | Notes |
| --- | --- | --- |
| Image | `image_hash` or `image_url`, plus `title`, `link_url` | `image_hash` is preferred after `UPLOAD_IMAGE`. |
| Video | `video_id` plus thumbnail `image_hash` or `image_url` | Missing thumbnail maps to Meta subcode `1443226`. |
| Carousel | `carousel_cards` with 2-10 cards | Each card needs at least one of `image_hash`, `image_url`, or `video_id`. |
| Placement-customized image | `placement_assets` with at least 2 assets and exactly 1 default | Uses `asset_feed_spec`; mutually exclusive with `video_id` and `carousel_cards`. |

Placement assets:

```ts
[
  { image_hash: "hash_square", is_default: true },
  { image_hash: "hash_vertical", placements: ["story", "reels"] }
]
```

Rules:

- `placement_assets` with `image_url` are uploaded first and replaced with
  `image_hash`.
- `asset_feed_spec.images` accepts hashes, not URLs.
- Exactly one default/fallback asset is required.
- The fallback rule uses `customization_spec: {}`.
- Do not invent `{ is_default: true }` inside Meta's customization rule shape.
- Instagram-serving placement assets require `object_story_spec.instagram_user_id`.
- AgentMode auto-resolves `instagram_user_id` from the page when possible.

Supported placement tokens in current code:

- `feed`
- `facebook_feed`
- `instagram_feed`
- `story`
- `stories`
- `facebook_story`
- `instagram_story`
- `reels`
- `facebook_reels`
- `instagram_reels`
- `explore`

### Ad Create / Update

Create shape sent to Meta:

```ts
{
  name: string,
  adset_id: string,
  creative: { creative_id: string },
  status: string // default PAUSED
}
```

Important: creative swaps must be nested as:

```ts
{
  creative: { creative_id: "..." }
}
```

A top-level `creative_id` can be silently ignored by Meta. This caused a shipped
bug where creative updates appeared successful but did not change the ad.

### Image Upload

AgentWeb pre-processes images before upload:

- Longest side is capped at 1936px.
- Byte cap is 8MB.
- PNG stays PNG when possible to preserve transparency.
- If PNG remains too large, it falls back to JPEG.
- Meta `/adimages` response is unwrapped from `{ images: { filename: { hash } } }`
  into a flat image entry.

Do not reintroduce filename-keyed hash handling into callers. That caused
distinct creatives to reuse or scramble image hashes.

### Insights

Allowed insights controls live in `metaConstants.ts`.

Allowed node types:

- `account`
- `campaign`
- `adset`
- `ad`

Allowed date presets include:

- `today`
- `yesterday`
- `this_month`
- `last_month`
- `last_3d`
- `last_7d`
- `last_14d`
- `last_28d`
- `last_30d`
- `last_90d`
- `maximum`
- `this_year`
- `last_year`

Do not add fields or breakdowns only in the tool schema. Add them to
`metaConstants.ts`, tests, and this contract.

## Known Failure Modes From PR History

Detailed PR research lives in [pr-research-index.md](./pr-research-index.md).

| Failure | Evidence | Current guard | Do not do this |
| --- | --- | --- | --- |
| Connected account path ignored | PR #959, #999, #1305, #1309 | `getMetaCredentials`; `list_meta_ads_campaigns` uses modern list path | Do not call only legacy `user.adAccount` unless documented as legacy-only. |
| Emma hallucinated Meta data when account not connected | PR #1326 | Auth errors return explicit failure instead of fake metrics | Do not fabricate empty or sample metrics. |
| Ad account not visible after OAuth | PR #1147, #1207, #1306 | Token session is stored in DynamoDB and selected accounts are persisted | Do not rely on in-memory OAuth state across backend instances. |
| Budget unit mismatch | PR #1608 | AgentMode uses dollars; MetaService receives cents for budgets/bids | Do not pass user-facing dollar values directly to SDK fields. |
| Image hash response shape caused wrong creative assets | PR #1744 | `uploadImage` unwraps `/adimages` response to flat `{ hash }` | Do not make callers parse filename-keyed maps. |
| Oversized image upload failed with vague Meta error | PR #1754 | `resizeImageForMeta` downscales/re-encodes before upload | Do not remove resize because tests pass with small fixtures. |
| Creative update did not reflect | PR #1756 | AD UPDATE nests `creative_id` under `creative` or builds a new creative then swaps | Do not send top-level `creative_id` to update an ad. |
| Placement-specific assets had invalid `asset_feed_spec` shape | PR #1766 | `validatePlacementAssets` and `createPlacementCustomizedCreative` encode the rule shape | Do not invent Meta rule keys; preserve fallback `customization_spec: {}`. |
| Instagram actor missing for IG placements | PR #1784 | AgentMode resolves `instagram_user_id` from page; service includes it in `object_story_spec` | Do not create IG-serving placement assets without an IG actor. |
| Insights output unreadable from S3 | PR #1724 | Insights wrapper returns inline and lets tool pipeline handle large response offload | Do not custom-upload insights without readable `s3_key` semantics. |
| LIST omitted paused-by-parent ads | PR #1433 | `listAds` includes `CAMPAIGN_PAUSED` and `ADSET_PAUSED` effective statuses | Do not filter only `ACTIVE` when user asks to pause or inspect all ads. |

## Tests To Check

Focused Meta tests:

- `backend/src/__tests__/metaService.validators.test.ts`
- `backend/src/__tests__/metaService.imageResize.test.ts`
- `backend/src/__tests__/metaService.test.ts`
- `backend/src/__tests__/metaApiFetch.test.ts`
- `backend/src/__tests__/metaAuth.test.ts`
- `backend/src/__tests__/metaRoutes.test.ts`
- `backend/src/__tests__/metaRoutes.campaignPerformance.test.ts`
- `backend/src/__tests__/metaV2Routes.test.ts`

AgentMode Meta tests:

- `backend/src/__tests__/agentModeService.metaValidation.test.ts`
- `backend/src/__tests__/agentModeService.metaCredentialsFallback.test.ts`
- `backend/src/__tests__/agentModeService.metaCampaignsCRUD.test.ts`
- `backend/src/__tests__/agentModeService.metaAdsCRUD.test.ts`
- `backend/src/__tests__/agentModeService.metaAdvanced.test.ts`
- `backend/src/__tests__/agentModeService.metaMetrics.test.ts`
- `backend/src/__tests__/agentModeService.metaPages.test.ts`
- `backend/src/__tests__/agentModeService.metaDatasets.test.ts`

Tool tests:

- `backend/src/__tests__/emma.metaAdsCampaignTools.test.ts`
- `backend/src/__tests__/mcp.tools.metaAds.test.ts`

When touching this contract, run the narrow tests first. If code changes touch
shared AgentMode behavior, run the appropriate backend CI shard locally or in CI.

## Agent Anti-Hallucination Rules

- Do not invent Meta objectives, billing events, optimization goals, bid
  strategies, insights fields, breakdowns, or placement tokens.
- Do not guess `account_id`, `campaign_id`, `ad_set_id`, `ad_id`, `page_id`, or
  `creative_id`. Get IDs from list calls.
- Do not remove `facebook` platform compatibility; old records can use it.
- Do not assume `account_id` includes `act_`; the internal normalized form omits
  it.
- Do not assume all metrics paths use connected accounts. `get_meta_ads_metrics`
  currently has legacy-only behavior.
- Do not claim an ad was changed unless the right entity was updated. Creative
  content changes usually require creating/swapping a creative, not mutating the
  old creative.
- Do not turn validation errors into generic "Meta failed" messages. The
  enriched messages are part of the product experience.

## Open Gaps

- `getMetaAdsMetrics` should probably migrate to `getMetaCredentials` so quick
  metrics and custom insights use the same account-resolution behavior.
- The objective/optimization/billing compatibility comments mention Meta v24,
  while runtime default is `v25.0`. The matrix should be rechecked before major
  expansion.
- Meta Page connected-account storage exists in types, but current marketing
  OAuth connect flow stores ad accounts, not page connected accounts.
- CTA compatibility is partly documented in tool text but not enforced by a
  dedicated validator for every objective/creative type.
- Vendor docs should be checked before adding new fields, not after a failure.

## Update Checklist

- [ ] If external API shape changed, verify against Meta's current docs.
- [ ] Update `backend/src/emma/tools.ts` if agent-facing schema or instructions
      changed.
- [ ] Update validators in `MetaService` or `AgentModeService` for deterministic
      failures.
- [ ] Add tests for each new required field, enum, unit conversion, or nested
      payload shape.
- [ ] Add new failure mode to this contract with PR/commit evidence.
