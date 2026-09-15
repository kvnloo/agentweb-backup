# Enigma Contract

Last derived from code: 2026-09-14

Owner area: `Argusoft / enrichment (ENG-1388)`

Primary risk: `Enigma returns CARD revenue for US card-accepting businesses, not total company revenue — presenting it as "revenue", or accepting a brand that isn't really the lead's company, silently corrupts lead data.`

## Agent Summary

- **What it is:** Enigma (enigma.com) GraphQL API. We use one query: find a US **Brand** by website (+ optional name) and read its latest **12-month card revenue** and YoY growth.
- **Card revenue ≠ revenue.** It comes from a panel of about a third of US consumer and small-business card transactions. Enigma says to exclude low card-adoption industries (B2B software, wholesale, manufacturing) and to treat mixed ones as a floor. Always label it "Card revenue (12 mo), as of `periodEndDate`".
- **Fail closed.** No brand, a brand whose own websites don't match our domain (TLD included), or a null/negative/undated value all mean *no value*. Nothing is guessed or repaired.
- **Billing is per value returned**, even when we discard the brand. A search with no brand costs $0. The ledger records exactly that (`recordEnigmaLedger`).
- **Status (2026-09-14): dormant.** The adapter exists, but nothing calls `getEnigmaService()` yet. Waterfall wiring, lead fields and surfaces are ENG-1388 Phase 2+.
- **Licence:** Enigma's public ToS is internal-use-only and non-sublicensable. Do not show Enigma values to customers, or copy them across tenants, until ENG-1930 confirms the terms.

## What AgentWeb Uses This For

| Capability | Supported? | Entry point | Notes |
| --- | --- | --- | --- |
| Brand lookup by website + card revenue | Yes (dormant) | `getEnigmaService()?.lookupBrandCardRevenue()` | No caller yet |
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
| Tests | `backend/src/__tests__/enigmaService.test.ts` | Invariants below |

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
      yoyGrowth: number | null, // ratio, 1.32 = +32%
      periodStartDate: "YYYY-MM-DD",
      periodEndDate: "YYYY-MM-DD"
    }
  },
  fetchedAt: ISO,
  expiresAt: epochSeconds       // found and not_found: +30d. Errors are never cached.
}
```

No lead fields are written in Phase 1.

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
- `cardTransactions.edges[].node`: `quantityType`, `period`, `projectedQuantity` (Float, **may be null** below Enigma's compliance threshold), `periodStartDate`, `periodEndDate`, `platformBrandId`. A non-null `platformBrandId` means one platform's slice, not the brand total; we ignore those rows.
- `rank: 0` meaning "latest period" is taken from Enigma's own examples; it isn't documented as a field.

Errors: `401/403` → `EnigmaAuthError`, `402` → `EnigmaCreditsExhaustedError`, `429` → `EnigmaRateLimitedError(retryAfterSec)`, other non-2xx → `EnigmaApiError`, HTTP 200 with `errors[]` → `EnigmaApiError`.

Billing (rate card effective 2026-08-10): per value returned. Brand 12M card revenue amount = 10 credits, 12M YoY growth = 10, brand name = 2, website = 2 (1 credit = $0.01). Empty values are free.

## Agent Tool Contract

None yet. No Emma tool calls Enigma. When one is added it must say "card revenue (12 mo) as of <date>" and never "revenue".

## Known Failure Modes

| Failure | Symptom | Guard/test | What not to do |
| --- | --- | --- | --- |
| Social or site-builder URL as input | Enigma matches the platform company (e.g. a facebook.com URL → Meta) | `skips social profile / site-builder subdomain` | Don't pass LinkedIn/Facebook/myshopify hosts |
| TLD mismatch (`acme.io` vs `acme.com`) | Wrong brand's revenue attached | `treats a brand on a different TLD as not found` | Don't compare on name alone |
| Malformed HTTP 200 (no `data.search` array) | Schema drift cached as a 30-day not_found | Factory throws `EnigmaApiError`; `treats a malformed HTTP 200 … as a failure` | Don't default a missing `search` to `[]` |
| Invalid period dates (`2026-02-30`, `2026-99-99`) | Plausible but wrong as-of date stored | Exact `YYYY-MM-DD` + calendar round-trip, else no value | Don't prefix-match or truncate dates |
| One customer's lookup served to another | Unlicensed reuse; free data for the second customer | Cache key scoped per user | Don't drop the user scope until ENG-1930 confirms reuse |
| Null card revenue for a small merchant | Value missing | `never fabricates a revenue value` | Don't back-fill from 1m/3m, Apollo or an LLM |
| Out of credits | Every lookup throws 402 | `does not cache a vendor error` + `[enigma] OUT OF CREDITS` log | Don't turn a 402 into `not_found` |
| B2B / SaaS company | Null or tiny card revenue | Not guarded (industry gating is Phase 2) | Don't present card revenue as company size |
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

- **No live call has been made.** The query shape comes from Enigma's published schema and examples (checked 2026-09-14), not a real response. Verify with the key (ENG-1931) before any caller ships: the `rank: 0` filter, how `platformBrandId` is populated, whether `id` bills.
- Rate-card values are **placeholder list prices** pending Harsha's allocation confirmation.
- Licence scope for customer display and cross-tenant reuse is unknown (ENG-1930).
- Industry gating (skip low card-adoption NAICS) is not implemented.
- No per-user daily quota. That's acceptable while there is no caller; decide before Phase 2 wiring.

## Update Checklist

- [ ] Vendor docs checked if external API shape changed.
- [ ] Code pointer list still accurate.
- [ ] Tests cover new or changed contract behavior.
- [ ] Failure modes updated if this change fixes a bug.
- [ ] Agent tool descriptions updated if users/agents call this integration.
