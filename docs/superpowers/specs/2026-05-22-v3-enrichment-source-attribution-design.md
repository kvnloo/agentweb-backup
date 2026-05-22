# V3 Enrichment — Source-Attribution & V2-Parity Fixes — Design

**Date:** 2026-05-22
**Branch:** `harshit/v3-enrichment-source-attribution-fixes` (from `origin/main`)
**Status:** Approved — ready for implementation planning

## Background

Two independent investigation passes audited how the V3 CRM-enrichment
pipeline records the *source* of each enriched field and how that source is
persisted in DynamoDB. The audits converged on the same code map and the same
verdicts; a manager revalidation against source confirmed the findings and
rejected one false positive (see "Rejected claim" below).

### How V3 enrichment stores source today

- **Table:** `${TABLE_PREFIX}AW-Leads`, item key `{ listId, leadId }`.
- The enriched **value** goes to a top-level lead column (standard columns) or
  into the `customFields` map.
- The **source attribution** goes into a separate `enrichmentMetadata` map,
  keyed by field name. Each entry is an `EnrichedFieldMeta`
  (`backend/src/utils/enrichedFieldValue.ts:8-50`):
  `{ source, provider?, sourceUrl?, sourceQuote?, confidence?, enrichedAt,
  enrichedJobId?, criticVerdict?, siblingLeadId?, ... }`.
- Written via `crmDb.setLeadFields` (`db.ts:6471`) as a nested document-path
  `SET` per field (`db.ts:6562-6568`); `writeLeadOutcome`
  (`crmEnrichmentServiceV3.ts:655`) copies each fill's `meta` verbatim into
  `enrichmentMetadata[field]`.
- Attribution is strictly per-field; there is no run-level source summary.

### Rejected claim

Investigator A flagged `enrichmentGroupWaterfall.ts:248`
(`crmHits.push({ field: f, value, meta: meta! })`) as able to persist
`undefined` meta. **This is a false positive.** Line 247 runs
`if (!isFresh(meta, f)) continue;` first, and `isFresh()`
(`enrichmentTtl.ts:35`) returns `false` for any `undefined`/`null` meta — so
line 248 is only reachable with a defined `meta`. The non-null assertion is
sound. No V3 path persists a value with no source via Tier 1.

## Verified gaps (in scope)

| # | Gap | Evidence |
|---|-----|----------|
| 1 | Web-tier fills carry no `provider`, `sourceUrl`, or `sourceQuote` | `metaWeb()` `enrichmentGroupWaterfall.ts:202-207`; ungrouped extractor `enrichmentV3RealDeps.ts:828-831` |
| 2 | Pattern-guessed emails mislabeled `provider:'enrich.so'`; the real pattern is discarded | `enrichmentIdentityResolver.ts:485-489` |
| 3 | Smart-field (`source:'llm'`) fills do not record which model produced them | `crmEnrichmentServiceV3.ts:618-628` |
| 5b | `source:'existing_data'` filter is dead code — no V3 path produces it | `crmEnrichmentServiceV3.ts:319` |
| Critic | V3's critic stamps `criticVerdict` but never surfaces it as an actionable per-field signal; also runs blind because web fills lack `sourceQuote`/`sourceUrl` | `crmEnrichmentServiceV3.ts:526-542` (comment at `:528`) |
| Confidence | `metaApollo()`/`metaWeb()` set no `confidence`; `getFieldConfidence()` registry is never imported by V3 | `enrichmentGroupWaterfall.ts:194-207`; `fieldConfidenceRegistry.ts` |
| Job ID | V3 generates `runId` (`crmEnrichmentServiceV3.ts:708`) but never writes it to `meta.enrichedJobId`; V2 does (`crmEnrichmentService.ts:1578`) | grep: `enrichedJobId` set only in V2 |

## Out of scope (separate spec)

V2's larger job features are intentionally excluded — they form a feature
subsystem (new DynamoDB table, revert API endpoint, customer-portal UI) and
warrant their own brainstorm → spec → plan cycle:

- Before/after **snapshots** + `revertJob()` undo.
- The `createEnrichmentJobMeta` **job-record table**.
- The 50-entry **per-lead failure list** (V3 returns only aggregate counters).

Also excluded (broader V2-parity, unrelated to source attribution): targeted
re-search/retry, LLM circuit breaker, extra-cost metering, Crunchbase
specialist, structured `enrichLog`. `EnrichedFieldMeta.normalized` is left
untouched per the brainstorm (neither implemented nor removed).

## The fixes

Fixes 1-7 are backend logic changes → TDD applies (red tests first, minimum
3 fail cases + 1 success per the project rule); `npx tsc` after every `.ts`
edit. Fix 8 is a customer-portal UI change → TDD does not apply (frontend UI
component, per the project rule); it follows the portal's existing test
strategy (`npm test`). One commit per fix, plus a release-note commit. Commit
messages must not include a `Co-Authored-By` / AI-identity trailer (user
preference).

### Fix 1 — Web-tier per-field provenance (GAP 1)

**Contract change.** `extractFieldsViaLLMReal` (`enrichmentV3RealDeps.ts:462`)
return type changes from `{ filled: Record<string,string>, missing }` to:

```ts
{ filled: Record<string, { value: string; sourceUrl?: string; sourceQuote?: string }>, missing: string[] }
```

- **Web tier only:** the LLM prompt asks for
  `{"field": {"value","sourceUrl","sourceQuote"}}` per field instead of a bare
  string. The Apollo-tier prompt is left untouched (it works today and Apollo
  JSON has no URLs); the function normalizes the Apollo bare-string result into
  the unified `{value}` shape internally.
- `metaWeb()` becomes `metaWeb(sourceUrl?, sourceQuote?)` and returns
  `{ source:'web_search', provider:'llm_web_search', sourceUrl, sourceQuote,
  confidence:'medium', enrichedAt }`. (`confidence` per Fix 6.)
- **Consumers updated:** the `LLMExtractResult` type behind
  `WaterfallDeps.extractFieldsViaLLM`; **all three** `deps.extractFieldsViaLLM`
  call sites in `enrichmentGroupWaterfall.ts` — Tier 3 Apollo reader
  (`:308-315` — reads `.value`, `metaApollo()`), Tier 3.5c Unipile-company
  reader (`:411-418` — reads `.value`, `metaUnipile()`), and Tier 4 web reader
  (`:447-454` — reads `.value`, passes URL/quote to `metaWeb()`); the ungrouped
  web extractor (`enrichmentV3RealDeps.ts:824-833`); and
  `rejectHallucinatedLinkedInUrls` (now operates on the object shape).
- **Payoff:** the Step 3 critic (`enrichmentV3RealDeps.ts:540-541`) already
  reads `sourceQuote`/`sourceUrl`; once populated, the critic fact-checks
  against real evidence instead of empty strings.

### Fix 2 — Pattern-guessed email attribution (GAP 2)

`enrichmentIdentityResolver.ts:485-489`: replace `makeApiMeta('enrich.so')` for
the pattern-matched email with:

```ts
{ source:'api', provider:'pattern', confidence:'medium',
  sourceQuote: `pattern: ${emailPattern}`, enrichedAt }
```

Add `'pattern'` to the `IdentityProvider` type. The already-captured
`patternResult.pattern` now reaches persistence instead of being discarded.

### Fix 3 — Smart-field model attribution (GAP 3)

The `evaluateSmartField` dep (`enrichmentV3RealDeps.ts:841`) returns
`{ value, reasoning, model }` — adding the `EXTRACT_MODEL` it used. The
smart-field meta builder (`crmEnrichmentServiceV3.ts:622-628`) sets
`provider: result.model` on the `source:'llm'` meta. Model knowledge stays in
`enrichmentV3RealDeps.ts`.

### Fix 4 — Remove dead `existing_data` branch (GAP 5b) — ⚠️ DROPPED

> ⚠️ **Dropped on revalidation (2026-05-22).** The branch is **not dead code**: V3 Tier 1 copies a lead's stored `enrichmentMetadata` verbatim (`enrichmentGroupWaterfall.ts:246-248`), and the v2 service writes `source:'existing_data'` (`crmEnrichmentService.ts:1569`) — so a v2-enriched lead re-run through V3 yields a real `existing_data` Tier-1 fill. The branch is an intentional `// value already in DB` guard. Removing it is not behaviour-preserving and has no upside, so Fix 4 is out of scope. Both audits and the earlier revalidation missed that V3 Tier 1 inherits v2-era stored meta.

Delete the unreachable filter `if (fill.meta.source === 'existing_data') continue;`
at `crmEnrichmentServiceV3.ts:319` — no V3 code path produces an
`existing_data` fill.

**Revalidation result:** the `'existing_data'` enum value **stays**. A grep
found it in active use by the v2 service (`crmEnrichmentService.ts`), the
`EnrichmentCacheSource` type (`enrichmentGroups.ts:5`), the enrichment prompts,
`enrichmentValidation.ts`, the CRM routes, and the customer-portal UI
(`enrichedFieldValue.ts` / `EnrichedValue.tsx`, which renders an 'Existing'
badge). Fix 4 is therefore a **single-line removal** in
`crmEnrichmentServiceV3.ts` only — it does not touch `enrichedFieldValue.ts`.

### Fix 5 — Critic verdict surfacing (non-destructive)

The Step 3 critic (`crmEnrichmentServiceV3.ts:526-542`) already stamps a
4-value `meta.criticVerdict` (`supported` / `partially-supported` /
`unsupported` / `contradicted`) on each web-tier fill, but the verdict is not
exposed as an actionable signal. Rather than V2's approach of silently
*deleting* contradicted values, V3 **surfaces** the critic's assessment as a
simple per-field review label and lets the user / UI decide — nothing is ever
auto-deleted, downgraded, or mutated.

Add `criticView?: 'drop' | 'low' | 'high'` to `EnrichedFieldMeta`. After the
critic stamps `criticVerdict`, derive and stamp `criticView`:

| `criticVerdict` | `criticView` |
|---|---|
| `contradicted` | `drop` (critic recommends removal — **not** auto-removed) |
| `unsupported`, `partially-supported` | `low` |
| `supported` | `high` |

`criticView` is persisted in `enrichmentMetadata[field]` like any other meta
key, so the customer-portal can render a high / low / drop quality badge per
web-sourced field. Applies to web-tier fills only — see the Tier-3 note. Purely
additive: no fill is dropped, downgraded, or mutated; same risk class as
Fixes 1-4, 7.

**Tier-3 note (CTO review).** The critic checks web-tier fills only; Apollo
Tier 3 (LLM-over-raw-JSON) fills are not critiqued. This is intentional — it
keeps the critic's scope and cost bounded. Fix 6's one-notch Tier-3 confidence
downgrade is the (softer) reliability signal for Tier 3. Documented as a
deliberate choice rather than an oversight.

### Fix 6 — Confidence restoration (absorbs GAP 4)

Wire the existing `getFieldConfidence()` registry
(`fieldConfidenceRegistry.ts:109` — supports providers `'apollo'` and
`'enrich.so'`, unknown fields default to `'medium'`) into V3:

- `metaApollo(field, opts?: { llmExtracted?: boolean })` →
  `confidence: getFieldConfidence('apollo', field)`. **GAP 4 absorbed:** Tier 2
  (deterministic direct-map) uses the raw registry value; Tier 3 (LLM
  extraction over Apollo raw JSON) passes `{ llmExtracted: true }`, which
  applies a one-notch downgrade (`high→medium`, `medium→low`, `low→low`) to
  reflect that LLM extraction is less reliable than a deterministic map.
- `makeApiMeta(provider, field?)` in the identity resolver →
  `getFieldConfidence` for `'apollo'`/`'enrich.so'`; `'unipile'` and
  `'pattern'` → `'medium'`. Note: two call sites (`:343`, `:514`) build one
  meta object and reuse it across several fields — these must be changed to
  call `makeApiMeta` per field so each field gets its own registry confidence
  (e.g. enrich.so `firstName`=`'high'` but `company`=`'medium'`).
- `metaWeb()` → `confidence:'medium'` base (the registry has no web provider;
  web's per-field quality signal is the Fix 5 `criticView` badge).
- `metaUnipile()` → `confidence:'medium'`.
- **Extend the registry (CTO review).** Add the identity fields to
  `APOLLO_FIELD_CONFIDENCE` in `fieldConfidenceRegistry.ts` —
  `firstName`/`lastName`/`email`/`linkedin` → `'high'`,
  `company`/`title`/`phone` → `'medium'` — so Apollo identity fields no longer
  silently default to `'medium'` while enrich.so rates the same fields `'high'`.

Result: every enriched field carries a `confidence` label.

### Fix 7 — Job traceability (`enrichedJobId`)

Thread the existing `runId` (`crmEnrichmentServiceV3.ts:708`) into
`writeLeadOutcome` and stamp `enrichedJobId: runId` onto every fill's `meta`
before it is persisted — done once at the `writeLeadOutcome`/`splitBucket`
chokepoint, so every field persisted by the synchronous `runEnrichment` write
path is covered. No schema change (`EnrichedFieldMeta.enrichedJobId` already
exists). Preview mode does not persist, so stamping there is optional and
omitted for minimalism.

**Documented limitation (revalidation).** The async Apollo broker webhook
(`apolloWebhook.ts:210-221`) writes `enrichmentMetadata.email` via
`crmDb.setLeadEmailIfMissing`, outside `writeLeadOutcome` and with no `runId`
in scope — so a webhook-sourced email fill will not carry `enrichedJobId`. It
already carries `apolloRequestId` (`apolloWebhook.ts:216`) as a traceability
handle. Threading `runId` through the async broker plumbing is deliberately out
of scope and can be picked up by the deferred job-record spec.

### Fix 8 — Customer-portal critic-view badge

Make the Fix 5 `criticView` signal visible to the user — the "show critic view"
goal. This lives in the customer-portal repo (separate from the backend), so it
gets its own branch and PR.

- `customer-portal/src/lib/enrichedFieldValue.ts` — add
  `criticView?: 'drop' | 'low' | 'high'` to the `EnrichedFieldMeta` mirror type
  (the mirror is hand-maintained and already lags the backend type).
- `customer-portal/src/components/crm/EnrichedValue.tsx` — render a small
  per-field badge for `criticView`: `high` (verified), `low` (questionable),
  `drop` (critic recommends removal). The value itself is never hidden or
  removed — the badge is advisory only.

Frontend UI change — TDD does not apply (project rule); follows the portal's
existing test strategy (`npm test`).

## Testing

Per-fix unit tests, written red-first:

- **Fix 1:** web extraction returns per-field `{value, sourceUrl, sourceQuote}`;
  `metaWeb()` shape; Tier 4 + ungrouped fills carry `provider`/URL/quote.
- **Fix 2:** pattern-email meta has `provider:'pattern'`, `confidence:'medium'`,
  `sourceQuote` containing the pattern.
- **Fix 3:** smart-field fill meta has `provider` set to the model.
- **Fix 4:** removing the dead branch does not change overwrite bucketing.
- **Fix 5:** `criticView` is derived per the mapping table (`contradicted`→
  `drop`, `unsupported`/`partially-supported`→`low`, `supported`→`high`) and
  persisted; no fill is removed or mutated.
- **Fix 6:** `metaApollo`/`makeApiMeta`/`metaWeb`/`metaUnipile` carry the
  expected `confidence`; Tier 3 `llmExtracted` downgrade behaves per the
  table; the extended Apollo registry returns the identity-field values.
- **Fix 7:** every persisted fill's `meta.enrichedJobId` equals the run's
  `runId`.
- **Fix 8:** the `EnrichedValue` component renders the expected badge for each
  `criticView` value and renders nothing when `criticView` is absent.

`npx tsc` after every `.ts` edit (including test files). CI requires ≥95%
coverage on statements/branches/functions/lines — new branches must be covered.

## PR structure

Three PRs across two repos:

- **PR A** (backend) — Fixes 1, 2, 3, 4, 7 (additive provenance metadata).
  Reviewed and deployed first as a zero-risk change.
- **PR B** (backend) — Fixes 5, 6 — branched on top of PR A's branch.
  Fixes 5/6 are not independent of the rest: Fix 5's critic needs Fix 1's
  source quotes to produce sane verdicts; Fix 6 edits `metaWeb()`/`makeApiMeta`,
  also edited by Fixes 1/2. Reviewed as the presentation change and rolled back
  independently of PR A if needed.
- **PR C** (customer-portal repo) — Fix 8, the critic-view badge, on a matching
  branch. Lands with or after PR B; before PR B the badge simply renders
  nothing (`criticView` is `undefined`), so it is forward-safe.

## Commit plan

One commit per fix (test + implementation together, atomic logical change),
plus one release-note commit. Fix 5 and Fix 6 are user-facing — the release
note (`backend/src/docs/user-release.ts`) covers: web-sourced enriched fields
now show a critic quality view (high / low / drop), and confidence labels are
restored across all enriched fields.

## Files touched

- `backend/src/services/enrichmentV3RealDeps.ts` — Fixes 1, 3, 6
- `backend/src/services/enrichmentGroupWaterfall.ts` — Fixes 1, 6
- `backend/src/services/crmEnrichmentServiceV3.ts` — Fixes 4, 5, 7
- `backend/src/services/enrichmentIdentityResolver.ts` — Fixes 2, 6
  (includes adding `'pattern'` to the `IdentityProvider` type, which is
  defined in this file)
- `backend/src/services/fieldConfidenceRegistry.ts` — Fix 6 (extend
  `APOLLO_FIELD_CONFIDENCE` with identity fields)
- `backend/src/utils/enrichedFieldValue.ts` — Fix 5 only (add the `criticView`
  field). Fix 4 does **not** touch this file — `'existing_data'` is confirmed
  in active use and the enum value stays.
- `backend/src/docs/user-release.ts` — release note
- `customer-portal/src/lib/enrichedFieldValue.ts` — Fix 8 (mirror the
  `criticView` field)
- `customer-portal/src/components/crm/EnrichedValue.tsx` — Fix 8 (render the
  critic-view badge)

Fixes 1, 6, 7 need no customer-portal change — `provider`, `sourceUrl`,
`sourceQuote`, `confidence`, and `enrichedJobId` are already present in the
portal's `EnrichedFieldMeta` mirror. Only Fix 5's new `criticView` field
requires the portal change (Fix 8).
