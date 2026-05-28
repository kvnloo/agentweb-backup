# Google Ads Integration Design

**Date:** 2026-05-28  
**Author:** harshit  
**Status:** Approved

---

## Overview

Full Google Ads integration for AgentWeb, following the established Meta Ads pattern. Delivers OAuth account connection, Google Ads API service layer, and 2 agent tools (management + reporting). UI campaign management is Phase 2.

---

## Phasing

**Phase 1 (this spec):** OAuth + account connection + `googleAdsService.ts` + 2 agent tools + Settings UI platform card  
**Phase 2 (future):** Campaign/ad group/ad management UI pages

---

## Architecture

### Approach

Direct Google Ads API integration using the `google-ads-api` npm package (Opteo's TypeScript-first client). Mirrors the Meta Ads pattern: `metaAuth.ts` → `metaService.ts` → `meta.ts` routes → `tools.ts` agent tools.

OAuth reuses the existing Google Cloud project (same client ID as Gmail/YouTube) but adds the `https://www.googleapis.com/auth/adwords` scope and its own Secrets Manager entry.

### New Files

| File | Purpose |
|---|---|
| `backend/src/routes/googleAdsAuth.ts` | OAuth init + callback (mirrors `youtubeAuth.ts`) |
| `backend/src/routes/googleAds.ts` | REST endpoints: list accounts, campaigns |
| `backend/src/services/googleAdsService.ts` | Google Ads API wrapper (CRUD + GAQL reporting) |
| `customer-portal/src/components/settings/GoogleAdsAccountModal.tsx` | Account selector UI (mirrors `MetaAdAccountModal.tsx`) |

### Modified Files

| File | Change |
|---|---|
| `backend/src/config/integrations.ts` | Add `google_ads` OAuth config + `getGoogleAdsConfig()` |
| `backend/src/utils/secretsManager.ts` | Add `getGoogleAdsCredentials()` |
| `backend/src/app.ts` | Register `googleAdsAuth` and `googleAds` routes |
| `backend/src/emma/tools.ts` | Add 2 Google Ads agent tools |
| `backend/src/services/agentModeService.ts` | Add tool handlers + system prompt instruction |
| `backend/src/docs/agentModeSystemPrompt.ts` | Add Google Ads workflow instructions |
| `customer-portal/src/pages/Settings.tsx` | Add Google Ads platform card |

---

## OAuth & Account Connection Flow

1. User clicks "Connect Google Ads" → `PlatformCard` calls `GET /api/oauth/google-ads/init`
2. Backend generates signed JWT state, redirects to Google consent with scope `https://www.googleapis.com/auth/adwords`
3. Google redirects to `GET /api/oauth/google-ads/callback?code=...&state=...`
4. Backend exchanges code for `access_token` + `refresh_token`, calls Google Ads API to list accessible accounts under the MCC manager
5. Backend redirects frontend to `/oauth/google-ads/callback?sessionId=...`
6. Frontend polls `GET /api/oauth/google-ads/session/:sessionId`, shows `GoogleAdsAccountModal` with account list
7. User selects account → `POST /api/oauth/google-ads/connect` stores in `connected_accounts`

### Connected Account Shape

```json
{
  "platform": "google_ads",
  "account_id": "123-456-7890",
  "account_name": "My Business Ads",
  "config": {
    "access_token": "...",
    "refresh_token": "...",
    "token_expiry": "2026-06-01T00:00:00Z",
    "customer_id": "1234567890"
  }
}
```

### Secrets Manager Entry

- Dev: `dev/AgentWeb/GoogleAds`
- Prod: `prod/AgentWeb/GoogleAds`

```json
{
  "clientId": "your_google_oauth_client_id",
  "clientSecret": "your_google_oauth_client_secret",
  "developerToken": "your_google_ads_developer_token",
  "managerCustomerId": "your_manager_customer_id"
}
```

### Token Refresh

Single-flight guard — if a refresh is already in-flight for a given userId, subsequent requests wait on the same promise rather than triggering a second refresh. Result is written back to `connected_accounts` once.

---

## Service Layer: `googleAdsService.ts`

**npm package:** `google-ads-api` by Opteo

### Campaign Types Supported

| Type | Ad Unit | Key Inputs |
|---|---|---|
| Search | Responsive Search Ad | Keywords + match types, 15 headlines, 4 descriptions, final URL |
| Display | Responsive Display Ad | Audiences, headlines, descriptions, image assets, final URL |
| Performance Max | Asset Group | Text + images + logos + optional video, audience signals, final URL |

### Public Methods

```typescript
// Account
listAccessibleAccounts(userId): Promise<AdAccount[]>

// Budgets — must be created before campaign
createBudget(userId, customerId, params: {
  amountMicros: number,          // e.g. 10_000_000 = $10/day
  deliveryMethod: 'STANDARD' | 'ACCELERATED'
}): Promise<Budget>

// Campaigns
listCampaigns(userId, customerId): Promise<Campaign[]>
createCampaign(userId, customerId, params: {
  name: string,
  type: 'SEARCH' | 'DISPLAY' | 'PERFORMANCE_MAX',
  budgetResourceName: string,
  biddingStrategy: 'MAXIMIZE_CONVERSIONS' | 'TARGET_CPA' | 'TARGET_ROAS'
    | 'MAXIMIZE_CONVERSION_VALUE' | 'TARGET_IMPRESSION_SHARE' | 'MANUAL_CPC',
  biddingStrategyTarget?: number,
  locationTargetIds: number[],   // required — no default
  status?: 'ENABLED' | 'PAUSED'
}): Promise<Campaign>
updateCampaign(userId, customerId, campaignId, params): Promise<Campaign>
pauseCampaign(userId, customerId, campaignId): Promise<void>
resumeCampaign(userId, customerId, campaignId): Promise<void>

// Ad Groups (Search + Display only)
listAdGroups(userId, customerId, campaignId): Promise<AdGroup[]>
createAdGroup(userId, customerId, params): Promise<AdGroup>
updateAdGroup(userId, customerId, adGroupId, params): Promise<AdGroup>

// Keywords (Search only)
addKeywords(userId, customerId, adGroupId, keywords: {
  text: string,
  matchType: 'BROAD' | 'PHRASE' | 'EXACT'
}[]): Promise<void>
addNegativeKeywords(userId, customerId, resourceId: {
  campaignId?: string,
  adGroupId?: string
}, keywords: { text: string, matchType: 'BROAD' | 'PHRASE' | 'EXACT' }[]): Promise<void>

// Ads (Search + Display)
listAds(userId, customerId, adGroupId): Promise<Ad[]>
createAd(userId, customerId, params): Promise<Ad>
updateAd(userId, customerId, adId, params): Promise<Ad>

// Assets (Display + PMax)
uploadAsset(userId, customerId, asset: {
  type: 'IMAGE' | 'LOGO' | 'VIDEO',
  data: Buffer | string
}): Promise<string>   // returns asset resource name

// Asset Groups (PMax only)
createAssetGroup(userId, customerId, campaignId, params: {
  name: string,
  headlines: string[],             // min 3, max 5
  longHeadlines: string[],         // min 1, max 5
  descriptions: string[],          // min 2, max 5
  squareImageAssets: string[],     // resource names from uploadAsset
  landscapeImageAssets: string[],  // resource names from uploadAsset
  logoAssets: string[],
  videoAssets?: string[],          // optional — Google auto-generates if omitted
  finalUrl: string,
  audienceSignals?: string[]
}): Promise<AssetGroup>

// Reporting
queryReporting(userId, customerId, gaqlQuery: string, dateRange: {
  since: string, until: string
}): Promise<S3UploadResult>

getQuickMetrics(userId, customerId, campaignIds: string[], dateRange): Promise<MetricsSummary>
```

---

## Agent Tools

### Tool 1: `call_google_ads_api`

Full ad management CRUD. The `LIST CAMPAIGN` action covers the campaign-listing need (no separate list tool needed).

**ACTION MATRIX:**

```
BUDGET        → CREATE
CAMPAIGN      → LIST, CREATE, UPDATE, PAUSE, RESUME
AD_GROUP      → LIST, CREATE, UPDATE         (Search + Display only)
KEYWORD       → ADD, ADD_NEGATIVE            (Search only)
AD            → LIST, CREATE, UPDATE         (Search + Display only)
ASSET         → UPLOAD                       (Display + PMax only)
ASSET_GROUP   → CREATE                       (PMax only)
LOCATION      → SEARCH
```

**Key agent instructions in tool description:**
- Always `CREATE BUDGET` before `CREATE CAMPAIGN`
- PMax: skip AD_GROUP/KEYWORD/AD — use ASSET_GROUP
- Display: UPLOAD image assets before creating ads
- `LOCATION SEARCH` to resolve location names to IDs
- Budget and cost values are in micros (× 1,000,000)

### Tool 2: `call_google_ads_reporting_api`

Reporting with two modes — covers both raw data and quick dashboard needs.

```typescript
{
  customer_id: string,
  mode: 'raw' | 'dashboard',
  // raw mode:
  query?: string,                // GAQL query
  date_range?: { since: string, until: string },
  date_preset?: 'LAST_7_DAYS' | 'LAST_30_DAYS' | 'LAST_90_DAYS'
               | 'THIS_MONTH' | 'LAST_MONTH' | 'THIS_YEAR',
  // dashboard mode:
  campaign_ids?: string[],       // omit for all campaigns
}
```

- `mode: 'raw'` — runs GAQL query, uploads JSON to S3, returns URL
- `mode: 'dashboard'` — pre-built metrics (spend, impressions, clicks, CTR, CPC, conversions), inline markdown

**GAQL examples baked into tool description:**

```sql
-- Campaign performance
SELECT campaign.id, campaign.name, metrics.impressions,
       metrics.clicks, metrics.cost_micros, metrics.conversions
FROM campaign WHERE segments.date DURING LAST_30_DAYS

-- Keyword performance
SELECT ad_group_criterion.keyword.text,
       ad_group_criterion.keyword.match_type,
       metrics.clicks, metrics.cost_micros, metrics.average_cpc
FROM keyword_view WHERE segments.date DURING LAST_30_DAYS
```

### System Prompt Addition

```
- Google Ads workflow: Use list_connected_accounts(platform='google_ads') to get customer_id.
  Reporting: call_google_ads_reporting_api (mode='dashboard' for quick summary, mode='raw' for custom GAQL).
  Campaign creation order: BUDGET → CAMPAIGN → AD_GROUP → KEYWORD/AD (Search/Display)
                           or BUDGET → CAMPAIGN → ASSET_GROUP (PMax).
  NEVER fabricate metrics — only report what tools return.
  Cost values from API are in micros — divide by 1,000,000 for dollar display.
```

---

## Settings UI

### Platform Card (after connection)

```
┌─────────────────────────────────────┐
│  [Google Ads logo]  Google Ads  ✓  │
│                                     │
│  My Business Ads                    │
│  Customer ID: 123-456-7890          │
│                                     │
│  [ Disconnect ]                     │
└─────────────────────────────────────┘
```

### Changes

- **`Settings.tsx`:** Add `google_ads` platform card; OAuth init via `GET /api/oauth/google-ads/init`; filter connected accounts by `platform === 'google_ads'`
- **`GoogleAdsAccountModal.tsx`:** Account selector after OAuth callback; `POST /api/oauth/google-ads/connect` on selection; `DELETE /api/oauth/google-ads/disconnect` on disconnect

---

## Error Handling

- Missing connected account → throw structured auth error (same pattern as `makeMetaAuthError`) so agent can surface setup instructions to user
- Token expired → auto-refresh with single-flight guard before retrying request
- Google Ads API errors → surface `error.message` + error code to agent/user
- Developer token not approved for production → surface clear message directing user to Google Ads API Center

---

## Testing

- Unit tests for `googleAdsService.ts` — mock `google-ads-api` client
- Unit tests for `googleAdsAuth.ts` routes — mock Secrets Manager + OAuth token exchange
- Unit tests for agent tool handlers in `agentModeService.ts`
- TypeScript compilation check: `npx tsc` after every file change

---

## Out of Scope (Phase 2)

- Campaign creation/management UI pages
- Ad group and ad editing UI
- Keyword management UI
- Asset upload UI
- Performance dashboard UI
