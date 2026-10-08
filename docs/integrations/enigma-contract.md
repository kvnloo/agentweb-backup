# Enigma Contract

Last derived from code: 2026-09-15 (Phase 2: V3 enrichment wiring)

Owner area: `Argusoft / enrichment (ENG-1388)`

Primary risk: `Enigma returns CARD revenue for US card-accepting businesses, not total company revenue — presenting it as "revenue", or accepting a brand that isn't really the lead's company, silently corrupts lead data.`

## Agent Summary

- **What it is:** Enigma (enigma.com) GraphQL API. We use one query: find a US **Brand** by website (+ optional name) and read its latest **12-month card revenue** and YoY growth.
- **Card revenue ≠ revenue.** It comes from a panel of about a third of US consumer and small-business card transactions. Enigma says to exclude low card-adoption industries (B2B software, wholesale, manufacturing) and to treat mixed ones as a floor. Always label it "Card revenue (12 mo), as of `periodEndDate`".
- **Fail closed.** No brand, a brand whose own websites don't match our domain (TLD included), or a null/negative/undated value all mean *no value*. Nothing is guessed or repaired.
- **Billing is per value returned**, even when we discard the brand. A search with no brand costs $0. The ledger records exactly that (`recordEnigmaLedger`).
- **Status (2026-09-15): wired into V3 enrichment, off by default.** Calls happen only when `ENIGMA_ENRICHMENT_ENABLED=true`, the user is on `ENIGMA_ENRICHMENT_USER_ALLOWLIST` (empty = nobody), the run is user-initiated (enrich-v3 route or Emma; never the cron) and the run's config explicitly names a card-revenue field. **Decided 2026-09-24: staying internal-use only, indefinitely.** Considered pursuing an Enterprise agreement with Enigma to unlock customer display; explicitly declined. `ENIGMA_ENRICHMENT_USER_ALLOWLIST` must never include a real customer account — that's the only thing enforcing this, since the portal display code (customer-portal PR #1169) has no independent check and renders whatever's on a lead regardless of account. Revisiting this needs a new product decision, not a resumption of ENG-1930.
- **Licence:** Enigma's public ToS (2020-02-25, re-verified 2026-09-24) is internal-use-only and non-sublicensable, and explicitly bars "service provider or similar purposes" — i.e. showing it to our own customers. ENG-1930 confirmed this and the decision was made to stay on it rather than negotiate an Enterprise agreement.

## What AgentWeb Uses This For

| Capability | Supported? | Entry point | Notes |
| --- | --- | --- | --- |
| Brand lookup by website + card revenue | Yes | `getEnigmaService()?.lookupBrandCardRevenue()` | Called only through the V3 `company_card_revenue` group |
| Lead enrichment fields | Yes (flag + allowlist) | V3 waterfall `runCardRevenueTier` | `card_revenue_12m`, `card_revenue_period_end`, `card_revenue_yoy_growth` |
| KYB / verify API | No | — | $1.50–2.50/call; not needed |
| Operating-location / market-rank data | No | — | Location revenue is in-store only |
| Bulk file enrichment / S3 output | No | — | Candidate for list backfills (Phase 4) |
| MCP server | No | — | Separate per-tool caps; beta |

## Code Pointers

| Area | Path | Purpose |
| --- | --- | --- |
| Service (pure) | `backend/src/services/enigmaService.ts` | Domain gate, cache-first lookup, match validation, value extraction, typed errors, `countEnigmaBilledFills` |
| Factory | `backend/src/services/enigmaServiceFactory.ts` | GraphQL query, `fetch` client, HTTP → error mapping, ledger metering, cache store, `initEnigmaServiceFromEnv` |
| Secret | `backend/src/utils/secretsManager.ts` `getEnigmaApiKey` | Plain string at `dev/AgentWeb/Enigma` / `prod/AgentWeb/Enigma` |
| Boot | `backend/src/server.ts` | Try/catch init; stays dormant without the secret |
| Rate card | `backend/src/utils/vendorRateCard.ts` `enigma` | `card_revenue_12m`, `card_revenue_yoy_growth_12m`, `brand_attribute` (placeholder list prices) |
| Metered providers | `backend/src/services/usageAnalyticsService.ts` `METERED_VENDOR_PROVIDERS` | Must include `enigma` |
| Cache discriminator | `backend/src/services/db.ts` `putEnrichmentCacheItem` | `cacheType: 'enigma'` |
| Enrichment policy | `backend/src/services/enigmaCardRevenueEnrichment.ts` | Flag/allowlist gate, industry card-adoption gate, per-run cap, 402/401 circuit breaker, run summary |
| Field group | `backend/src/services/enrichmentGroups.ts` `company_card_revenue`, `isCardRevenueField` | 30d TTL; exact-name-only fields |
| Waterfall tier | `backend/src/services/enrichmentGroupWaterfall.ts` `runCardRevenueTier` | Enigma or nothing; returns before Tiers 2–5 |
| Deps wiring | `backend/src/services/enrichmentV3RealDeps.ts` `buildOrchestratorDeps(userId, { enigma })` | Route and Emma pass `enigma: true`; cron does not |
| Opt-in guards | `enrichmentConfigService.ts` (default `include:false`, alias/smart-dep stripping), `enrichmentConfigDeps.ts` (LLM cheat sheets), `crmEnrichmentServiceV3.ts` (no injected card deps) | No implicit purchase |
| Exclusions | `enrichmentSiblingConfigFields.ts` (no cross-tenant copy), `enrichmentCacheService.ts` `splitFieldsByGroup` (no V2 web fill), `cron/crmAutoEnrichmentCron.ts` (`isUnenriched` ignores card fields) | |
| Daily quota | `enigmaService.ts` `EnigmaQuotaTracker`, `enigmaServiceFactory.ts` `buildEnigmaQuotaTracker` | AW-Configs `system:enigmaUsage`, `ENIGMA_DAILY_LIMIT_PER_USER` (default 150) |
| Monthly credit budget | same tracker (`reserve` / `settle`) | AW-Configs `system:enigmaCreditBudget` (userId `system`), `ENIGMA_MONTHLY_CREDIT_BUDGET` (default 1,800 of the 2,100 Pro plan; 0 disables). Reserved atomically before each call (`ENIGMA_MAX_CREDITS_PER_CALL` = 52), then trued up to `countEnigmaBilledCredits`, the same values the ledger meters |
| Tests | `backend/src/__tests__/enigmaService.test.ts`, `backend/src/__tests__/enigmaCardRevenueEnrichment.test.ts` | Invariants below |

## Stored Internal Shape

`AW-EnrichmentRawCache` (existing table, TTL'd rows). **Only the normalized result is stored**, never the raw vendor payload.

```ts
{
  canonicalId: sha256("enigma:brand:<user:<userId> | platform>:<host>"),   // per-user scope: no cross-customer reuse (ENG-1930)
  fieldGroup: "enigma:brand_card_revenue#v1",
  cacheType: "enigma",
  canonicalKey: "enigma:brand:user:<userId>:<host>",
  entityKey: "enigma:brand:user:<userId>:<host>",
  entityType: "enigma",
  status: "hit" | "not_found",
  rawData: {
    status: "found" | "not_found",
    brandId?: string,           // Enigma Brand id
    brandName?: string,
    matchedWebsite?: string,    // Enigma-side registrable domain that confirmed the match
    cardRevenue12m: null | {
      amountUsd: number,        // period TOTAL (not monthly average — that was legacy v1)
      yoyGrowth: number | null, // signed change: 0.32 = +32%, -0.61 = -61% (NOT a ratio; see below)
      periodStartDate: "YYYY-MM-DD",
      periodEndDate: "YYYY-MM-DD"
    }
  },
  fetchedAt: ISO,
  expiresAt: epochSeconds       // found and not_found: +30d. Errors are never cached.
}
```

**Lead fields (V3 enrichment)**, all strings in `customFields` (Tier 1 freshness and the writer only understand strings):

```ts
customFields.card_revenue_12m        = "4250000"      // USD, plain decimal
customFields.card_revenue_period_end = "2026-05-31"   // not *_date, so the normalizer keeps ISO
customFields.card_revenue_yoy_growth = "0.32"         // signed change (+32%; -0.61 = -61%), NOT a ratio; omitted when Enigma returns null
enrichmentMetadata[field] = {
  source: "api", provider: "enigma",
  confidence: "medium" (period_end: "high"),
  asOf: "2026-05-31", fromCache, enrichedAt,
  sourceQuote: "Card spend on US consumer and small-business cards over the 12 months ending … Not total revenue …"
}
```

**Daily quota row:** AW-Configs `{ userId, configId: "system:enigmaUsage", date: "YYYY-MM-DD", callCount }`.
**Credit budget row:** AW-Configs `{ userId: "system", configId: "system:enigmaCreditBudget", month: "YYYY-MM", creditCount }` (reserved credits until settled). Table prefix comes from `config/constants.ts` `TABLE_PREFIX`, the same as `db.ts` and the enrichment cache.

## External Payload Contract

`POST https://api.enigma.com/graphql`, header `x-api-key: <key>`, 30s timeout.

Variables sent:

```json
{
  "searchInput": {
    "entityType": "BRAND",
    "website": "<normalized host>",
    "name": "<company name, optional>",
    "matchThreshold": 0.8,
    "conditions": { "limit": 1 }
  },
  "cardTransactionConditions": {
    "filter": { "AND": [
      { "EQ": ["period", "12m"] },
      { "EQ": ["rank", 0] },
      { "IN": ["quantityType", ["card_revenue_amount", "card_revenue_yoy_growth"]] }
    ] }
  }
}
```

- `limit` belongs **only** in `SearchInput.conditions`. Sub-connections use `first:`.
- `search` returns `[SearchUnion]` (`LegalEntity | Brand | OperatingLocation`); we read only `... on Brand`.
- `websites.edges[].node` is a `Website` with `website`, `domain` and `topLevelDomain`. Match confirmation uses `domain + "." + topLevelDomain`.
- `cardTransactions.edges[].node`: `quantityType`, `period`, `projectedQuantity` (Float, **may be null** below Enigma's compliance threshold), `periodStartDate`, `periodEndDate`, `platformBrandId`. A non-null `platformBrandId` means one platform's slice, not the brand total; we ignore those rows. **They are still billed** (ENG-1933: Blueland returned 1 amount + 3 YoY rows, 2 of them platform-attributed, 44 credits).
- `card_revenue_yoy_growth`: Enigma's reference docs describe it as *"the ratio of the brand's current period's revenue to the period one year prior's revenue"*, but live responses return a **signed change**: Kurtz Fargo `-0.6069`, Blueland `0.0739` (ENG-1933, 2026-09-18). A ratio can't be negative, so we treat it as a change. Values below `-1` are discarded.
- A website-only search returned `search: []` for brands that the same search **with the company name** found (kurtzfargo.com, blueland.com; ENG-1933). Pass the name whenever the lead has one.
- `rank: 0` meaning "latest period" is taken from Enigma's own examples; it isn't documented as a field.

Errors: `401/403` → `EnigmaAuthError`, `402` → `EnigmaCreditsExhaustedError`, `429` → `EnigmaRateLimitedError(retryAfterSec)`, other non-2xx → `EnigmaApiError`, HTTP 200 with `errors[]` → `EnigmaApiError`.

Billing (rate card effective 2026-08-10): per value returned. Brand 12M card revenue amount = 10 credits, 12M YoY growth = 10, brand name = 2, website = 2 (1 credit = $0.01). Empty values are free.

## Agent Tool Contract

No dedicated tool. Emma reaches Enigma only through `enrich_leads_preview` / `enrich_leads_execute` / `enrich_lead_custom` when the user explicitly asks for card revenue. The tool descriptions tell her to request the exact field names, never to use them for a generic "revenue" ask, and to always say "card revenue … 12 months to <asOf>", never total revenue (`search_leads` / `get_lead_details` provenance text).

## Known Failure Modes

| Failure | Symptom | Guard/test | What not to do |
| --- | --- | --- | --- |
| Social or site-builder URL as input | Enigma matches the platform company (e.g. a facebook.com URL → Meta) | `skips social profile / site-builder subdomain` | Don't pass LinkedIn/Facebook/myshopify hosts |
| AgentWeb form host stored as company website | Wasted lookup on `*.agentwebforms.com` (5 of 5 Every day-zero leads, ENG-1933) | `skips AgentWeb form host` | Don't look up our own hosts |
| YoY read as a ratio | A falling brand's YoY dropped; UI shows +7% as −93% | `keeps a falling YoY, ignores platform-attributed YoY rows` | Don't subtract 1 or drop negatives |
| TLD mismatch (`acme.io` vs `acme.com`) | Wrong brand's revenue attached | `treats a brand on a different TLD as not found` | Don't compare on name alone |
| Malformed HTTP 200 (no `data.search` array) | Schema drift cached as a 30-day not_found | Factory throws `EnigmaApiError`; `treats a malformed HTTP 200 … as a failure` | Don't default a missing `search` to `[]` |
| Invalid period dates (`2026-02-30`, `2026-99-99`) | Plausible but wrong as-of date stored | Exact `YYYY-MM-DD` + calendar round-trip, else no value | Don't prefix-match or truncate dates |
| One customer's lookup served to another | Unlicensed reuse; free data for the second customer | Cache key scoped per user | Don't drop the user scope until ENG-1930 confirms reuse |
| Null card revenue for a small merchant | Value missing | `never fabricates a revenue value` | Don't back-fill from 1m/3m, Apollo or an LLM |
| Out of credits | Every lookup throws 402 | `does not cache a vendor error` + `[enigma] OUT OF CREDITS` log | Don't turn a 402 into `not_found` |
| B2B / SaaS company | Null or tiny card revenue | `classifyCardAdoption` skips low-adoption industries (keyword rules; unknown industry still calls) | Don't present card revenue as company size |
| Card field switched on implicitly | Surprise spend on every later run | Default `include:false`; aliases and smart deps onto card fields stripped; LLM cheat sheets exclude the group | Don't add card fields to `CANONICAL_SYNONYMS` or LLM prompts |
| Web/LLM guess at card revenue | Fabricated value indistinguishable from Enigma | `runCardRevenueTier` returns before Tiers 2–5; V2 `splitFieldsByGroup` drops card fields | Don't let the card group fall through the waterfall |
| Out of credits mid-run | Every lead calls and fails | Run circuit breaker (`haltedBy`) after the first 402/401 | Don't retry 402/401 per lead |
| Cross-customer reuse | Licensed data shown to another tenant | Sibling copy skips card fields and any `provider: enigma` value | Don't remove until ENG-1930 confirms reuse is licensed |
| Values billed but discarded (website mismatch) | Ledger spend with no stored value | `records each billed value` | Don't skip metering on a rejected match |

## Tests To Check

- `backend/src/__tests__/enigmaService.test.ts`
- `backend/src/__tests__/vendorMeteringCoverageGuard.test.ts` (signature `api.enigma.com` + provider parity)
- `backend/src/__tests__/vendorRateCard.test.ts`

## Recent PR/Commit Evidence

- ENG-1388 Phase 1 (this change): dormant adapter, metering, cache.
- ENG-1111: egress guard wraps `fetch`, which is why this client doesn't use axios.
- ENG-696 / ENG-703: ledger-in-factory pattern and central rate card.
- ENG-122 / ENG-968: fail-closed enrichment lineage.

## Open Gaps

- **Live spike done (ENG-1933, 2026-09-18, 35 calls, 664 credits).** The query works. Still open: platform-attributed rows are billed (up to 3 extra × 10 credits per brand); a query-side filter for `platformBrandId` null is being verified before we rely on it. Whether `id` bills is unconfirmed: no credit balance was readable before or after the run, so the 664 comes from our own fill count.
- Location leads get the brand (chain) total, e.g. one Salt & Straw shop → the chain's $91.6M.
- Rate-card values are **placeholder list prices** pending Harsha's allocation confirmation.
- Licence scope for customer display and cross-tenant reuse is unknown (ENG-1930).
- Industry gating uses keyword rules over free-text industry (we have no NAICS); tune with ENG-1933 spike data.
- **Caps and budget (set from ENG-1933):** 100 lookups/run (`ENIGMA_MAX_CALLS_PER_RUN`), 150 calls/user/day (`ENIGMA_DAILY_LIMIT_PER_USER`), 1,800 credits/month platform-wide (`ENIGMA_MONTHLY_CREDIT_BUDGET`). The spike measured ~19 credits per live call against a 2,100-credit/month plan, so call caps alone can't bound spend; the budget can. The per-run cap counts lookups including cache hits (conservative). Both limits reserve capacity with one conditional DynamoDB write **before** the call (user/day: `callCount < limit`; platform/month: `creditCount <= budget - 52`), so concurrent lookups cannot all pass one stale read. `settle` then releases the difference once Enigma has billed, and the whole reservation when the call fails. A fresh counter replaces only a missing or strictly older day/month row, so a request straddling midnight fails closed instead of overwriting the newer counter. Neither can overshoot; Enigma's own 402 stays the final stop.
- **Per-call cost ceiling: 52 credits (~$0.52).** `cardTransactions(first: 4)` = 4 x 10, name 2, `websites(first: 5)` = 5 x 2. Typical is ~19; platform-attributed rows we discard are still billed.
- `enigma_brand_id` is not persisted on leads (design D2 deviation: no consumer needs it; the cache is keyed by host).
- Portal display ("Card revenue (12 mo)" label, as-of date, tooltip, `enigma` provenance) is customer-portal PR #1169. Until it is live, a card field shows as a raw key and value with no provenance, so keep the flag off for real customer accounts (also gated on ENG-1930).
- Customer display and cross-tenant reuse remain gated on ENG-1930; who pays on ENG-1932 H1.

## Update Checklist

- [ ] Vendor docs checked if external API shape changed.
- [ ] Code pointer list still accurate.
- [ ] Tests cover new or changed contract behavior.
- [ ] Failure modes updated if this change fixes a bug.
- [ ] Agent tool descriptions updated if users/agents call this integration.
