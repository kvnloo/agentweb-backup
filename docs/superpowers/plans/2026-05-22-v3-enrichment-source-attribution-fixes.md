# V3 Enrichment Source-Attribution Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the seven verified source-attribution gaps in the V3 CRM-enrichment pipeline — every enriched field must carry a real `provider`, a `confidence` label, the producing run's `enrichedJobId`, web-tier `sourceUrl`/`sourceQuote`, and a critic-derived quality view — and surface the critic view as a per-field badge in the customer portal. Implements the approved design at `docs/superpowers/specs/2026-05-22-v3-enrichment-source-attribution-design.md`.

**Architecture:** Eight fixes across two repos, grouped into three PRs. PR A (Fixes 1-4, 7) is purely additive provenance metadata on the backend — zero behaviour risk, ships first. PR B (Fixes 5-6) is the presentation layer (critic-view derivation + confidence restoration), stacked on PR A's branch. PR C (Fix 8) is the customer-portal badge, on a matching branch in the separate `customer-portal` repo. Backend fixes 1-7 are logic changes → strict TDD (red test first, minimum 3 fail cases + 1 success case per fix). Fix 8 is a frontend UI change → no TDD; follows the portal's existing `npm test` strategy. The release note (Task 8) is its own commit.

**Tech Stack:** Node.js / TypeScript, Express, DynamoDB, Jest (backend); React / TypeScript, Vitest, Testing Library (customer-portal).

---

## Background

Two independent audit passes of how the V3 enrichment pipeline records the *source* of each enriched field converged on the same gaps. The enriched **value** goes to a top-level lead column or `customFields`; the **source attribution** goes to a separate `enrichmentMetadata` map keyed by field name, each entry an `EnrichedFieldMeta` (`backend/src/utils/enrichedFieldValue.ts`). `writeLeadOutcome` (`crmEnrichmentServiceV3.ts`) copies each fill's `meta` verbatim into `enrichmentMetadata[field]`.

Verified gaps closed by this plan:

| Fix | Gap | File(s) |
|-----|-----|---------|
| 1 | Web-tier fills carry no `provider` / `sourceUrl` / `sourceQuote` | `enrichmentGroupWaterfall.ts`, `enrichmentV3RealDeps.ts` |
| 2 | Pattern-guessed emails mislabeled `provider:'enrich.so'`; pattern discarded | `enrichmentIdentityResolver.ts` |
| 3 | Smart-field (`source:'llm'`) fills do not record which model produced them | `enrichmentV3RealDeps.ts`, `crmEnrichmentServiceV3.ts` |
| 4 | `source:'existing_data'` filter is dead code in V3 | `crmEnrichmentServiceV3.ts` |
| 5 | Critic stamps `criticVerdict` but never surfaces an actionable per-field signal | `crmEnrichmentServiceV3.ts`, `enrichedFieldValue.ts` |
| 6 | `metaApollo()`/`metaWeb()` set no `confidence`; the registry is never wired into V3 | `enrichmentGroupWaterfall.ts`, `enrichmentIdentityResolver.ts`, `fieldConfidenceRegistry.ts` |
| 7 | V3 generates `runId` but never writes it to `meta.enrichedJobId` | `crmEnrichmentServiceV3.ts` |
| 8 | Customer portal cannot render the new `criticView` signal | `customer-portal/src/lib/enrichedFieldValue.ts`, `customer-portal/src/components/crm/EnrichedValue.tsx` |

### Out of scope (do NOT touch)

- The `'existing_data'` enum value in `EnrichedFieldMeta.source` — confirmed in active use by the v2 service, the cache-source type, prompts, validation, CRM routes, and the customer-portal UI. Fix 4 removes only the dead *filter branch* in `crmEnrichmentServiceV3.ts`, not the enum.
- `EnrichedFieldMeta.normalized` — left untouched per the brainstorm.
- The async Apollo broker webhook (`apolloWebhook.ts`) — a webhook-sourced email fill is written outside `writeLeadOutcome` with no `runId` in scope; it already carries `apolloRequestId`. Threading `runId` into the async broker is deliberately deferred.
- V2's job-record table, snapshots/revert, and the 50-entry failure list — separate spec.

---

## File Structure

**Backend — modified (source):**
- `backend/src/services/crmEnrichmentServiceV3.ts` — Fixes 3, 4, 5, 7 (smart-field provider, dead-branch removal, criticView derivation, `runId`→`enrichedJobId` threading).
- `backend/src/services/enrichmentV3RealDeps.ts` — Fixes 1, 3 (web-tier per-field provenance in `extractFieldsViaLLMReal` + ungrouped extractor + `rejectHallucinatedLinkedInUrls`; `evaluateSmartField` returns `model`).
- `backend/src/services/enrichmentGroupWaterfall.ts` — Fixes 1, 6 (`LLMExtractResult` shape; `metaWeb(sourceUrl?,sourceQuote?)`; `metaApollo(field,opts?)`/`metaWeb()`/`metaUnipile()` confidence; all three `extractFieldsViaLLM` call sites).
- `backend/src/services/enrichmentIdentityResolver.ts` — Fixes 2, 6 (`'pattern'` added to `IdentityProvider`; pattern-email meta; `makeApiMeta(provider,field?)` per-field confidence).
- `backend/src/services/fieldConfidenceRegistry.ts` — Fix 6 (extend `APOLLO_FIELD_CONFIDENCE` with identity fields).
- `backend/src/utils/enrichedFieldValue.ts` — Fix 5 (add `criticView?` to `EnrichedFieldMeta`).
- `backend/src/docs/user-release.ts` — release note (Task 8).

**Backend — modified (tests):**
- `backend/src/__tests__/enrichmentWaterfall.v3.test.ts` — Fix 1 contract migration: the existing `extractFieldsViaLLM` mocks return the old `filled: Record<string,string>` shape and MUST be migrated to the new `Record<string,{value}>` shape, plus new Fix 1 / Fix 6 assertions.
- `backend/src/__tests__/crmEnrichmentServiceV3.test.ts` — Fixes 3, 5, 7 tests.
- `backend/src/__tests__/enrichmentIdentityResolver.test.ts` — Fixes 2, 6 tests.
- `backend/src/__tests__/fieldConfidenceRegistry.test.ts` — Fix 6 registry-extension tests.

**Customer-portal — modified:**
- `customer-portal/src/lib/enrichedFieldValue.ts` — Fix 8 (mirror `criticView?`).
- `customer-portal/src/components/crm/EnrichedValue.tsx` — Fix 8 (render the badge).
- `customer-portal/src/__tests__/components/crm/EnrichedValue.test.tsx` — Fix 8 badge tests.

---

## Shared Conventions

- **Backend** commands run from `backend/` (i.e. `/home/harshit/IdeaProjects/Agentweb/agentweb2/backend`).
- **Customer-portal** commands run from `customer-portal/` (i.e. `/home/harshit/IdeaProjects/Agentweb/agentweb2/customer-portal`) — it is a **separate git repo**.
- **After every edit to any `.ts` file (including test files), run `npx tsc` before moving on** (project rule). For the customer-portal repo, `npx tsc` runs from `customer-portal/`.
- Run a focused backend test file with `npx jest <pattern>` (e.g. `npx jest crmEnrichmentServiceV3`). Run a focused customer-portal test with `npx vitest run <pattern>`.
- Each task = one commit (test + implementation together — one atomic logical change). Task 8 (release note) is its own commit.
- **Commit messages must NOT include a `Co-Authored-By` trailer or any AI-identity line** (hard user rule).
- **PR A branch** `harshit/v3-enrichment-source-attribution-fixes` already exists and is checked out — Tasks 1-5 commit here. **PR B branch** `harshit/v3-enrichment-critic-view` is created from the tip of the PR A branch at the start of Task 6 (genuine stacked PR — independent review and rollback) — Tasks 6-8 commit there. The customer-portal branch is created in Task 9.

### Type / signature contracts (used identically across tasks)

These names appear in multiple tasks — use them exactly as written:

- **`LLMFilledValue`** — new exported interface in `enrichmentGroupWaterfall.ts`:
  ```ts
  export interface LLMFilledValue {
    value: string;
    sourceUrl?: string;
    sourceQuote?: string;
  }
  ```
- **`LLMExtractResult`** (in `enrichmentGroupWaterfall.ts`) — `filled` changes from `Record<string,string>` to `Record<string, LLMFilledValue>`.
- **`extractFieldsViaLLMReal`** return type (in `enrichmentV3RealDeps.ts`) — `{ filled: Record<string, LLMFilledValue>; missing: string[] }`.
- **`metaApollo(field: string, opts?: { llmExtracted?: boolean }): EnrichedFieldMeta`** — group waterfall.
- **`metaWeb(sourceUrl?: string, sourceQuote?: string): EnrichedFieldMeta`** — group waterfall.
- **`metaUnipile(): EnrichedFieldMeta`** — group waterfall (signature unchanged, body gains `confidence`).
- **`makeApiMeta(provider: IdentityProvider, field?: string): EnrichedFieldMeta`** — identity resolver.
- **`criticView?: 'drop' | 'low' | 'high'`** — new optional field on `EnrichedFieldMeta` (backend) and its customer-portal mirror.

---

# PR A — Backend: Additive Provenance (ships first)

PR A bundles Fixes 4, 3, 2, 7, 1 (Tasks 1-5). Every change is additive metadata — no fill is dropped, downgraded, or mutated. Reviewed and deployed first as a zero-risk change.

---

### Task 1 — Fix 4: Remove the dead `existing_data` branch — ⚠️ DROPPED

> ⚠️ **DROPPED on revalidation (2026-05-22) — do NOT execute this task.** During execution the `existing_data` branch was found to be **not dead code**: V3 Tier 1 (`enrichmentGroupWaterfall.ts:246-248`) copies a lead's stored `enrichmentMetadata` verbatim, and the v2 service writes `source:'existing_data'` (`crmEnrichmentService.ts:1569`) — so a lead enriched by v2 and re-run through V3 produces a genuine `existing_data` Tier-1 fill. The branch (commented `// value already in DB`) is an intentional guard, not dead code. Removing it is not behaviour-preserving and has no upside. Fix 4 is removed from scope; the steps below are retained for the record only.

`bucketByOverwritePolicy` in `crmEnrichmentServiceV3.ts` has a filter `if (fill.meta.source === 'existing_data') continue;`. No V3 code path ever produces an `existing_data` fill — V3 Tier 1 CRM hits copy the lead's *existing* `enrichmentMetadata[f]` verbatim (whatever source it had), and no waterfall tier emits `source:'existing_data'`. The branch is unreachable dead code. This is a single-line removal; the `'existing_data'` enum value in `EnrichedFieldMeta.source` **stays** (in active use elsewhere).

**Files:**
- Modify: `backend/src/services/crmEnrichmentServiceV3.ts` (line 319, inside `bucketByOverwritePolicy`)
- Test: `backend/src/__tests__/crmEnrichmentServiceV3.test.ts`

- [ ] **Step 1: Write the failing/lock-in tests**

Removing dead code is behaviour-preserving, but the project rule requires tests. These tests lock in that bucketing is unaffected by the source value — they will FAIL before the change only if written to assert the new behaviour; here they pass on current code too, so treat them as regression locks (per the project's "minimum 3 fail-case + 1 success-case" rule, the fail cases below assert overwrite-policy edge cases that the removed branch could have masked).

Add to `backend/src/__tests__/crmEnrichmentServiceV3.test.ts`, as a new `describe` block at the end of the file:

```typescript
describe('runEnrichment — overwrite bucketing ignores meta.source', () => {
  // Fix 4: the dead `existing_data` filter is removed; bucketing must depend
  // only on overwritePolicy + current lead value, never on meta.source.

  function leadWithCompany(): LeadRecord {
    return makeLead({ leadId: 'lead-1', company: 'OldCo', email: 'jane@acme.com' });
  }

  it('FAIL CASE: fill_if_empty does NOT overwrite an existing value regardless of source', async () => {
    const setLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([leadWithCompany()]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{ field: 'company', value: 'NewCo', meta: { source: 'existing_data', enrichedAt: '2026-01-01T00:00:00Z' } }],
        missing: [],
        tierFills: { crm: 0, apollo: 1, web: 0, missing: 0 },
      }),
      setLeadFields,
    });
    await runEnrichment(makeInput({ config: makeConfig({
      fields: [{ name: 'company', type: 'string', instruction: 'co', include: true, overwritePolicy: 'fill_if_empty' }],
    }) }), deps);
    // company is already 'OldCo' on the lead → fill_if_empty skips it.
    expect(setLeadFields).not.toHaveBeenCalled();
  });

  it('FAIL CASE: always_overwrite writes even when meta.source is existing_data', async () => {
    const setLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([leadWithCompany()]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{ field: 'company', value: 'NewCo', meta: { source: 'existing_data', enrichedAt: '2026-01-01T00:00:00Z' } }],
        missing: [],
        tierFills: { crm: 0, apollo: 1, web: 0, missing: 0 },
      }),
      setLeadFields,
    });
    await runEnrichment(makeInput({ config: makeConfig({
      fields: [{ name: 'company', type: 'string', instruction: 'co', include: true, overwritePolicy: 'always_overwrite' }],
    }) }), deps);
    expect(setLeadFields).toHaveBeenCalledTimes(1);
    expect((setLeadFields as jest.Mock).mock.calls[0][0].topLevel).toEqual({ company: 'NewCo' });
  });

  it('FAIL CASE: fill_if_empty writes into an empty field even when meta.source is existing_data', async () => {
    const setLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead({ leadId: 'lead-1', email: 'jane@acme.com' })]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{ field: 'company', value: 'NewCo', meta: { source: 'existing_data', enrichedAt: '2026-01-01T00:00:00Z' } }],
        missing: [],
        tierFills: { crm: 0, apollo: 1, web: 0, missing: 0 },
      }),
      setLeadFields,
    });
    await runEnrichment(makeInput({ config: makeConfig({
      fields: [{ name: 'company', type: 'string', instruction: 'co', include: true, overwritePolicy: 'fill_if_empty' }],
    }) }), deps);
    expect(setLeadFields).toHaveBeenCalledTimes(1);
    expect((setLeadFields as jest.Mock).mock.calls[0][0].topLevel).toEqual({ company: 'NewCo' });
  });

  it('SUCCESS CASE: an apollo-source fill into an empty field is written', async () => {
    const setLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead({ leadId: 'lead-1', email: 'jane@acme.com' })]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{ field: 'company', value: 'Acme', meta: { source: 'api', provider: 'apollo', enrichedAt: '2026-01-01T00:00:00Z' } }],
        missing: [],
        tierFills: { crm: 0, apollo: 1, web: 0, missing: 0 },
      }),
      setLeadFields,
    });
    await runEnrichment(makeInput({ config: makeConfig({
      fields: [{ name: 'company', type: 'string', instruction: 'co', include: true, overwritePolicy: 'fill_if_empty' }],
    }) }), deps);
    expect(setLeadFields).toHaveBeenCalledTimes(1);
    expect((setLeadFields as jest.Mock).mock.calls[0][0].topLevel).toEqual({ company: 'Acme' });
  });
});
```

- [ ] **Step 2: Run the tests to confirm the baseline**

Run: `npx jest crmEnrichmentServiceV3 -t "overwrite bucketing ignores meta.source"`
Expected: all four PASS on current code (the dead branch is a no-op because no V3 path emits `existing_data` — these tests assert the bucketing semantics the removal must preserve). If any fail now, stop — that means the dead branch was actually reachable and the spec's premise is wrong.

- [ ] **Step 3: Remove the dead branch**

In `backend/src/services/crmEnrichmentServiceV3.ts`, inside `bucketByOverwritePolicy`, the `for` loop currently reads:

```typescript
  const fillIfEmpty: FieldFill[] = [];
  const alwaysOverwrite: FieldFill[] = [];
  for (const fill of fills) {
    if (fill.meta.source === 'existing_data') continue;   // value already in DB
    const policy = policyByField.get(fill.field) ?? config.globalOverwriteDefault;
```

Replace those lines with (delete only the `existing_data` line):

```typescript
  const fillIfEmpty: FieldFill[] = [];
  const alwaysOverwrite: FieldFill[] = [];
  for (const fill of fills) {
    const policy = policyByField.get(fill.field) ?? config.globalOverwriteDefault;
```

- [ ] **Step 4: Verify compilation and tests**

Run: `npx tsc`
Expected: no errors.

Run: `npx jest crmEnrichmentServiceV3`
Expected: PASS (all existing tests + the four new ones).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/crmEnrichmentServiceV3.ts backend/src/__tests__/crmEnrichmentServiceV3.test.ts
git commit -m "refactor(enrichment): remove dead existing_data branch from v3 bucketing"
```

---

### Task 2 — Fix 3: Smart-field model attribution

The `evaluateSmartField` dep (`enrichmentV3RealDeps.ts`) runs an LLM via `EXTRACT_MODEL` but returns only `{ value, reasoning }`. The smart-field meta builder in `crmEnrichmentServiceV3.ts` stamps `source:'llm'` with no `provider`, so the model that produced the value is lost. Extend the dep to return `model`, and stamp `provider: result.model` on the smart-field meta. The `OrchestratorDeps.evaluateSmartField` interface return type must also be widened.

**Files:**
- Modify: `backend/src/services/crmEnrichmentServiceV3.ts` (the `evaluateSmartField` interface return type ~line 212; the smart-field meta builder ~lines 618-628)
- Modify: `backend/src/services/enrichmentV3RealDeps.ts` (`evaluateSmartField` impl ~lines 841-860)
- Test: `backend/src/__tests__/crmEnrichmentServiceV3.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `backend/src/__tests__/crmEnrichmentServiceV3.test.ts`, as a new `describe` block at the end of the file:

```typescript
describe('runEnrichment — smart-field meta records the producing model', () => {
  function smartConfig(): EnrichmentConfig {
    return makeConfig({
      fields: [
        {
          name: 'isQualified',
          type: 'string',
          instruction: 'qualified?',
          include: true,
          overwritePolicy: 'always_overwrite',
          smartCondition: 'company has > 100 employees',
        },
      ],
    });
  }

  it('FAIL CASE: smart-field fill meta has provider set to the model from evaluateSmartField', async () => {
    const setLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead({ leadId: 'lead-1' })]),
      evaluateSmartField: jest.fn().mockResolvedValue({ value: 'yes', reasoning: 'big company', model: 'gpt-5-chat-2' }),
      setLeadFields,
    });
    await runEnrichment(makeInput({ config: smartConfig() }), deps);
    const meta = (setLeadFields as jest.Mock).mock.calls[0][0].enrichmentMetadata.isQualified;
    expect(meta.source).toBe('llm');
    expect(meta.provider).toBe('gpt-5-chat-2');
  });

  it('FAIL CASE: smart-field meta omits provider when evaluateSmartField returns no model', async () => {
    const setLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead({ leadId: 'lead-1' })]),
      evaluateSmartField: jest.fn().mockResolvedValue({ value: 'yes', reasoning: 'r' }),
      setLeadFields,
    });
    await runEnrichment(makeInput({ config: smartConfig() }), deps);
    const meta = (setLeadFields as jest.Mock).mock.calls[0][0].enrichmentMetadata.isQualified;
    expect(meta.source).toBe('llm');
    expect(meta.provider).toBeUndefined();
  });

  it('FAIL CASE: smart-field meta provider reflects an overridden model name', async () => {
    const setLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead({ leadId: 'lead-1' })]),
      evaluateSmartField: jest.fn().mockResolvedValue({ value: 'no', reasoning: 'r', model: 'gpt-4.1' }),
      setLeadFields,
    });
    await runEnrichment(makeInput({ config: smartConfig() }), deps);
    const meta = (setLeadFields as jest.Mock).mock.calls[0][0].enrichmentMetadata.isQualified;
    expect(meta.provider).toBe('gpt-4.1');
  });

  it('SUCCESS CASE: a null smart-field value produces no fill at all', async () => {
    const setLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead({ leadId: 'lead-1' })]),
      evaluateSmartField: jest.fn().mockResolvedValue({ value: null, reasoning: '', model: 'gpt-5-chat-2' }),
      setLeadFields,
    });
    await runEnrichment(makeInput({ config: smartConfig() }), deps);
    // No value → no fill → no write.
    expect(setLeadFields).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest crmEnrichmentServiceV3 -t "smart-field meta records the producing model"`
Expected: FAIL — the three FAIL-CASE tests fail because the current meta builder does not set `provider`. The first two also currently fail TypeScript-side at runtime only if `model` is read; they fail on the `provider` assertion. (The SUCCESS CASE passes already — that is fine; it locks the null path.)

- [ ] **Step 3: Widen the `evaluateSmartField` interface return type**

In `backend/src/services/crmEnrichmentServiceV3.ts`, the `OrchestratorDeps` interface declares (~lines 205-212):

```typescript
  evaluateSmartField(input: {
    lead: LeadRecord;
    fieldName: string;
    condition: string;
    /** Canonical dep name → enriched value, gathered from waterfall fills
     *  and the lead's existing field data. */
    depValues: Record<string, string>;
  }): Promise<{ value: string | null; reasoning: string }>;
```

Replace the return type so it carries the optional model:

```typescript
  evaluateSmartField(input: {
    lead: LeadRecord;
    fieldName: string;
    condition: string;
    /** Canonical dep name → enriched value, gathered from waterfall fills
     *  and the lead's existing field data. */
    depValues: Record<string, string>;
  }): Promise<{ value: string | null; reasoning: string; model?: string }>;
```

- [ ] **Step 4: Stamp `provider` on the smart-field meta**

In `backend/src/services/crmEnrichmentServiceV3.ts`, the smart-field fill currently reads (~lines 618-628):

```typescript
        if (evalResult.value !== null) {
          allFills.push({
            field: sf.name,
            value: evalResult.value,
            meta: {
              source: 'llm',
              enrichedAt: new Date().toISOString(),
              confidence: 'medium',
              ...(evalResult.reasoning ? { sourceQuote: evalResult.reasoning } : {}),
            },
          });
        }
```

Replace with:

```typescript
        if (evalResult.value !== null) {
          allFills.push({
            field: sf.name,
            value: evalResult.value,
            meta: {
              source: 'llm',
              enrichedAt: new Date().toISOString(),
              confidence: 'medium',
              ...(evalResult.model ? { provider: evalResult.model } : {}),
              ...(evalResult.reasoning ? { sourceQuote: evalResult.reasoning } : {}),
            },
          });
        }
```

- [ ] **Step 5: Verify compilation after the orchestrator edits**

Run: `npx tsc`
Expected: no errors.

- [ ] **Step 6: Make the `evaluateSmartField` dep return `model`**

In `backend/src/services/enrichmentV3RealDeps.ts`, the dep implementation currently reads (~lines 841-860):

```typescript
    evaluateSmartField: async ({ fieldName, condition, depValues }) => {
      const {
        buildSmartFieldEvalSystemPrompt,
        buildSmartFieldEvalUserPrompt,
      } = await import('./enrichmentPrompts');
      try {
        const llm = createLLMService(EXTRACT_MODEL, 0.0);
        const result = await llm.generateJSONContent<{ value: string | null; reasoning: string }>(
          buildSmartFieldEvalSystemPrompt(),
          buildSmartFieldEvalUserPrompt(fieldName, condition, depValues),
        );
        return {
          value: result?.value != null ? String(result.value) : null,
          reasoning: result?.reasoning ?? '',
        };
      } catch (err) {
        console.warn('[v3 deps] evaluateSmartField failed:', (err as Error).message);
        return { value: null, reasoning: '' };
      }
    },
```

Replace with (add `model: EXTRACT_MODEL` to the success return only — the catch path produced no value, so no model is recorded):

```typescript
    evaluateSmartField: async ({ fieldName, condition, depValues }) => {
      const {
        buildSmartFieldEvalSystemPrompt,
        buildSmartFieldEvalUserPrompt,
      } = await import('./enrichmentPrompts');
      try {
        const llm = createLLMService(EXTRACT_MODEL, 0.0);
        const result = await llm.generateJSONContent<{ value: string | null; reasoning: string }>(
          buildSmartFieldEvalSystemPrompt(),
          buildSmartFieldEvalUserPrompt(fieldName, condition, depValues),
        );
        return {
          value: result?.value != null ? String(result.value) : null,
          reasoning: result?.reasoning ?? '',
          model: EXTRACT_MODEL,
        };
      } catch (err) {
        console.warn('[v3 deps] evaluateSmartField failed:', (err as Error).message);
        return { value: null, reasoning: '' };
      }
    },
```

- [ ] **Step 7: Verify compilation and tests**

Run: `npx tsc`
Expected: no errors.

Run: `npx jest crmEnrichmentServiceV3 enrichmentV3RealDeps`
Expected: PASS (all existing + the four new tests).

- [ ] **Step 8: Commit**

```bash
git add backend/src/services/crmEnrichmentServiceV3.ts backend/src/services/enrichmentV3RealDeps.ts backend/src/__tests__/crmEnrichmentServiceV3.test.ts
git commit -m "feat(enrichment): record producing model on v3 smart-field metadata"
```

---

### Task 3 — Fix 2: Pattern-guessed email attribution

`enrichmentIdentityResolver.ts` Tier 7 (pattern matching) finds an email via `deps.findEmailViaPatterns` and stamps `meta.email = makeApiMeta('enrich.so')` — mislabeling the source as enrich.so and discarding the already-captured `patternResult.pattern`. Replace it with a meta that names the real provider (`'pattern'`), sets `confidence:'medium'`, and records the pattern in `sourceQuote`. `'pattern'` must be added to the `IdentityProvider` union type.

**Files:**
- Modify: `backend/src/services/enrichmentIdentityResolver.ts` (`IdentityProvider` type ~line 14; Tier 7 block ~lines 485-490)
- Test: `backend/src/__tests__/enrichmentIdentityResolver.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `backend/src/__tests__/enrichmentIdentityResolver.test.ts`, as a new `describe` block at the end of the file:

```typescript
describe('resolveIdentity — Tier 7 pattern-email attribution (Fix 2)', () => {
  // Tier 7 fires when email is absent but emailDomain + firstName + lastName
  // are all known. The found email's meta must name 'pattern' as the provider
  // and carry the pattern string in sourceQuote.

  function tier7Input() {
    return makeInput({
      lead: { leadId: LEAD_ID, firstName: 'Jane', lastName: 'Doe', emailDomain: 'acme.com' },
      needsPersonFields: false,
      needsCompanyFields: false,
    });
  }

  it('FAIL CASE: pattern-email meta has provider "pattern", not "enrich.so"', async () => {
    const writeLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      findEmailViaPatterns: jest.fn().mockResolvedValue({ email: 'jane.doe@acme.com', pattern: 'first.last' }),
      writeLeadFields,
    });
    await resolveIdentity(tier7Input(), deps);
    const meta = (writeLeadFields as jest.Mock).mock.calls[0][0].meta.email;
    expect(meta.source).toBe('api');
    expect(meta.provider).toBe('pattern');
  });

  it('FAIL CASE: pattern-email meta carries the pattern in sourceQuote', async () => {
    const writeLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      findEmailViaPatterns: jest.fn().mockResolvedValue({ email: 'jane.doe@acme.com', pattern: 'first.last' }),
      writeLeadFields,
    });
    await resolveIdentity(tier7Input(), deps);
    const meta = (writeLeadFields as jest.Mock).mock.calls[0][0].meta.email;
    expect(meta.sourceQuote).toBe('pattern: first.last');
  });

  it('FAIL CASE: pattern-email meta confidence is "medium"', async () => {
    const writeLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      findEmailViaPatterns: jest.fn().mockResolvedValue({ email: 'jane.doe@acme.com', pattern: 'flast' }),
      writeLeadFields,
    });
    await resolveIdentity(tier7Input(), deps);
    const meta = (writeLeadFields as jest.Mock).mock.calls[0][0].meta.email;
    expect(meta.confidence).toBe('medium');
  });

  it('SUCCESS CASE: the resolved email value is still persisted', async () => {
    const writeLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      findEmailViaPatterns: jest.fn().mockResolvedValue({ email: 'jane.doe@acme.com', pattern: 'first.last' }),
      writeLeadFields,
    });
    const result = await resolveIdentity(tier7Input(), deps);
    expect(result.ok).toBe(true);
    expect((writeLeadFields as jest.Mock).mock.calls[0][0].fields.email).toBe('jane.doe@acme.com');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest enrichmentIdentityResolver -t "Tier 7 pattern-email attribution"`
Expected: FAIL — the three FAIL-CASE tests fail because the current meta is `makeApiMeta('enrich.so')` (provider `'enrich.so'`, no `sourceQuote`, no `confidence`). The SUCCESS CASE passes already.

- [ ] **Step 3: Add `'pattern'` to the `IdentityProvider` type**

In `backend/src/services/enrichmentIdentityResolver.ts`, line 14 currently reads:

```typescript
export type IdentityProvider = 'apollo' | 'enrich.so' | 'unipile';
```

Replace with:

```typescript
export type IdentityProvider = 'apollo' | 'enrich.so' | 'unipile' | 'pattern';
```

- [ ] **Step 4: Replace the Tier 7 meta**

In `backend/src/services/enrichmentIdentityResolver.ts`, the Tier 7 block currently reads (~lines 485-490):

```typescript
      if (patternResult?.email) {
        email = patternResult.email;
        resolved.email = patternResult.email;
        meta.email = makeApiMeta('enrich.so');
        emailPattern = patternResult.pattern;
      }
```

Replace with:

```typescript
      if (patternResult?.email) {
        email = patternResult.email;
        resolved.email = patternResult.email;
        meta.email = {
          source: 'api',
          provider: 'pattern',
          confidence: 'medium',
          ...(patternResult.pattern ? { sourceQuote: `pattern: ${patternResult.pattern}` } : {}),
          enrichedAt: new Date().toISOString(),
        };
        emailPattern = patternResult.pattern;
      }
```

- [ ] **Step 5: Verify compilation and tests**

Run: `npx tsc`
Expected: no errors. (`'pattern'` is now a valid `IdentityProvider`; the inline object satisfies `EnrichedFieldMeta`.)

Run: `npx jest enrichmentIdentityResolver`
Expected: PASS (all existing + the four new tests).

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/enrichmentIdentityResolver.ts backend/src/__tests__/enrichmentIdentityResolver.test.ts
git commit -m "fix(enrichment): attribute pattern-guessed emails to the pattern provider"
```

---

### Task 4 — Fix 7: Thread `runId` into `writeLeadOutcome` as `enrichedJobId`

`runEnrichment` generates `const runId = randomUUID()` but never writes it onto any fill's meta. V2 stamps `enrichedJobId`; V3 does not. Thread `runId` into `writeLeadOutcome` and stamp `meta.enrichedJobId = runId` on every fill at the `splitBucket` chokepoint — so every field persisted by the synchronous write path is covered. `EnrichedFieldMeta.enrichedJobId` already exists — no schema change. Preview mode does not persist, so it is not stamped.

**Files:**
- Modify: `backend/src/services/crmEnrichmentServiceV3.ts` (`writeLeadOutcome` signature ~line 655 and `splitBucket` ~lines 667-680; the `writeLeadOutcome` call site ~line 919)
- Test: `backend/src/__tests__/crmEnrichmentServiceV3.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `backend/src/__tests__/crmEnrichmentServiceV3.test.ts`, as a new `describe` block at the end of the file:

```typescript
describe('runEnrichment — enrichedJobId stamping (Fix 7)', () => {
  it('FAIL CASE: every persisted fill carries meta.enrichedJobId equal to the run id', async () => {
    const setLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead({ leadId: 'lead-1' })]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [
          { field: 'company', value: 'Acme', meta: { source: 'api', provider: 'apollo', enrichedAt: '2026-01-01T00:00:00Z' } },
        ],
        missing: [],
        tierFills: { crm: 0, apollo: 1, web: 0, missing: 0 },
      }),
      setLeadFields,
    });
    const result = await runEnrichment(makeInput({ config: makeConfig({
      fields: [{ name: 'company', type: 'string', instruction: 'co', include: true, overwritePolicy: 'always_overwrite' }],
    }) }), deps);
    const meta = (setLeadFields as jest.Mock).mock.calls[0][0].enrichmentMetadata.company;
    expect(meta.enrichedJobId).toBe(result.runId);
  });

  it('FAIL CASE: enrichedJobId is identical across multiple fields written for one lead', async () => {
    const setLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead({ leadId: 'lead-1' })]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [
          { field: 'company', value: 'Acme', meta: { source: 'api', provider: 'apollo', enrichedAt: '2026-01-01T00:00:00Z' } },
          { field: 'industry', value: 'SaaS', meta: { source: 'api', provider: 'apollo', enrichedAt: '2026-01-01T00:00:00Z' } },
        ],
        missing: [],
        tierFills: { crm: 0, apollo: 2, web: 0, missing: 0 },
      }),
      setLeadFields,
    });
    const result = await runEnrichment(makeInput({ config: makeConfig({
      fields: [
        { name: 'company', type: 'string', instruction: 'co', include: true, overwritePolicy: 'always_overwrite' },
        { name: 'industry', type: 'string', instruction: 'ind', include: true, overwritePolicy: 'always_overwrite' },
      ],
    }) }), deps);
    const md = (setLeadFields as jest.Mock).mock.calls[0][0].enrichmentMetadata;
    expect(md.company.enrichedJobId).toBe(result.runId);
    expect(md.industry.enrichedJobId).toBe(result.runId);
  });

  it('FAIL CASE: stamping enrichedJobId does not erase other meta keys', async () => {
    const setLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead({ leadId: 'lead-1' })]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [
          { field: 'company', value: 'Acme', meta: { source: 'api', provider: 'apollo', confidence: 'high', enrichedAt: '2026-01-01T00:00:00Z' } },
        ],
        missing: [],
        tierFills: { crm: 0, apollo: 1, web: 0, missing: 0 },
      }),
      setLeadFields,
    });
    await runEnrichment(makeInput({ config: makeConfig({
      fields: [{ name: 'company', type: 'string', instruction: 'co', include: true, overwritePolicy: 'always_overwrite' }],
    }) }), deps);
    const meta = (setLeadFields as jest.Mock).mock.calls[0][0].enrichmentMetadata.company;
    expect(meta.provider).toBe('apollo');
    expect(meta.confidence).toBe('high');
  });

  it('SUCCESS CASE: preview mode does not call setLeadFields (no stamping path)', async () => {
    const setLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead({ leadId: 'lead-1' })]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{ field: 'company', value: 'Acme', meta: { source: 'api', provider: 'apollo', enrichedAt: '2026-01-01T00:00:00Z' } }],
        missing: [],
        tierFills: { crm: 0, apollo: 1, web: 0, missing: 0 },
      }),
      setLeadFields,
    });
    await runEnrichment(makeInput({ mode: 'preview', config: makeConfig({
      fields: [{ name: 'company', type: 'string', instruction: 'co', include: true, overwritePolicy: 'always_overwrite' }],
    }) }), deps);
    expect(setLeadFields).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest crmEnrichmentServiceV3 -t "enrichedJobId stamping"`
Expected: FAIL — the three FAIL-CASE tests fail because `enrichedJobId` is currently never set on persisted meta. The SUCCESS CASE passes already.

- [ ] **Step 3: Add a `runId` parameter to `writeLeadOutcome`**

In `backend/src/services/crmEnrichmentServiceV3.ts`, `writeLeadOutcome` currently begins (~lines 655-680):

```typescript
async function writeLeadOutcome(
  lead: LeadRecord,
  outcome: PerLeadOutcome,
  input: RunEnrichmentInput,
  deps: OrchestratorDeps,
): Promise<{ ok: true } | { ok: false; reason: 'update' }> {
  if (input.mode === 'preview') return { ok: true };
  const { fillIfEmpty, alwaysOverwrite } = bucketByOverwritePolicy(lead, outcome.fills, input.config);

  // Split each fill by destination — standard CRM columns write to the lead's
  // top-level attributes (so values appear in the same column shown in the
  // lead table); custom fields write to the customFields map.
  const splitBucket = (fills: FieldFill[]) => {
    const topLevel: Record<string, string> = {};
    const customFields: Record<string, string> = {};
    const enrichmentMetadata: Record<string, EnrichedFieldMeta> = {};
    for (const f of fills) {
      if (STANDARD_LEAD_COLUMNS.has(f.field)) {
        topLevel[f.field] = f.value;
      } else {
        customFields[f.field] = f.value;
      }
      enrichmentMetadata[f.field] = f.meta;
    }
    return { topLevel, customFields, enrichmentMetadata };
  };
```

Replace those lines with (add the `runId` parameter and stamp `enrichedJobId` in `splitBucket`):

```typescript
async function writeLeadOutcome(
  lead: LeadRecord,
  outcome: PerLeadOutcome,
  input: RunEnrichmentInput,
  deps: OrchestratorDeps,
  runId: string,
): Promise<{ ok: true } | { ok: false; reason: 'update' }> {
  if (input.mode === 'preview') return { ok: true };
  const { fillIfEmpty, alwaysOverwrite } = bucketByOverwritePolicy(lead, outcome.fills, input.config);

  // Split each fill by destination — standard CRM columns write to the lead's
  // top-level attributes (so values appear in the same column shown in the
  // lead table); custom fields write to the customFields map. Every persisted
  // fill is stamped with this run's id so the field is traceable to the job
  // that produced it (V2-parity — see crmEnrichmentService.ts).
  const splitBucket = (fills: FieldFill[]) => {
    const topLevel: Record<string, string> = {};
    const customFields: Record<string, string> = {};
    const enrichmentMetadata: Record<string, EnrichedFieldMeta> = {};
    for (const f of fills) {
      if (STANDARD_LEAD_COLUMNS.has(f.field)) {
        topLevel[f.field] = f.value;
      } else {
        customFields[f.field] = f.value;
      }
      enrichmentMetadata[f.field] = { ...f.meta, enrichedJobId: runId };
    }
    return { topLevel, customFields, enrichmentMetadata };
  };
```

- [ ] **Step 4: Pass `runId` at the call site**

In `backend/src/services/crmEnrichmentServiceV3.ts`, the Pass-2 concurrent write block currently reads (~lines 915-923):

```typescript
    if (pendingWrites.length > 0) {
      const writeResults = await Promise.all(
        pendingWrites.map(async ({ lead, outcome }) => {
          const wStart = Date.now();
          const writeResult = await writeLeadOutcome(lead, outcome, input, deps);
          console.log(`[v3][lead ${lead.leadId}] write in ${Date.now() - wStart}ms (ok=${writeResult.ok})`);
          return writeResult;
        }),
      );
```

Replace with (add `runId` as the fifth argument):

```typescript
    if (pendingWrites.length > 0) {
      const writeResults = await Promise.all(
        pendingWrites.map(async ({ lead, outcome }) => {
          const wStart = Date.now();
          const writeResult = await writeLeadOutcome(lead, outcome, input, deps, runId);
          console.log(`[v3][lead ${lead.leadId}] write in ${Date.now() - wStart}ms (ok=${writeResult.ok})`);
          return writeResult;
        }),
      );
```

- [ ] **Step 5: Verify compilation and tests**

Run: `npx tsc`
Expected: no errors. (`runId` is in scope at the call site — declared at the top of `runEnrichment`. `writeLeadOutcome` has no other call sites — confirm with `grep -n "writeLeadOutcome" backend/src/services/crmEnrichmentServiceV3.ts`: only the definition and this one call.)

Run: `npx jest crmEnrichmentServiceV3`
Expected: PASS (all existing + the four new tests).

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/crmEnrichmentServiceV3.ts backend/src/__tests__/crmEnrichmentServiceV3.test.ts
git commit -m "feat(enrichment): stamp run id as enrichedJobId on every v3 fill"
```

---

### Task 5 — Fix 1: Web-tier per-field provenance

The biggest change. Web-tier LLM extraction currently returns a bare `Record<string,string>` and `metaWeb()` carries no `provider`, `sourceUrl`, or `sourceQuote` — so the critic (which reads `sourceQuote`/`sourceUrl`) runs blind, and the provenance UI shows nothing for web fills. This task changes the `extractFieldsViaLLMReal` contract so each filled field is an object `{ value, sourceUrl?, sourceQuote? }`, asks the web-tier LLM prompt for that shape, normalizes the Apollo-tier bare-string result into the same shape internally, and threads URL/quote into `metaWeb()`.

**Contract change.** `LLMExtractResult.filled` (group waterfall) and `extractFieldsViaLLMReal`'s return `filled` become `Record<string, LLMFilledValue>` where `LLMFilledValue = { value: string; sourceUrl?: string; sourceQuote?: string }`.

**Files:**
- Modify: `backend/src/services/enrichmentGroupWaterfall.ts` (`LLMFilledValue` + `LLMExtractResult` types; `metaWeb`; the three `extractFieldsViaLLM` consumer call sites at Tier 3, Tier 3.5c, Tier 4)
- Modify: `backend/src/services/enrichmentV3RealDeps.ts` (`extractFieldsViaLLMReal` signature + body; `rejectHallucinatedLinkedInUrls`; the ungrouped extractor)
- Test: `backend/src/__tests__/enrichmentWaterfall.v3.test.ts` (migrate existing `filled` mocks + add Fix 1 assertions)

> **Migration note.** `enrichmentWaterfall.v3.test.ts` has 15 `extractFieldsViaLLM` mocks that return the OLD `filled: Record<string,string>` shape. Once `LLMExtractResult.filled` becomes `Record<string,LLMFilledValue>`, every one of those mocks stops compiling. Step 1 introduces a one-line `fv()` helper and migrates all 15 — this is mechanical but mandatory; `npx tsc` will not pass otherwise.

- [ ] **Step 1: Add the `fv()` test helper and write the new Fix 1 tests**

In `backend/src/__tests__/enrichmentWaterfall.v3.test.ts`, add this helper immediately after the `makeInput` function (after its closing `}` near line 71):

```typescript
// Fix 1: extractFieldsViaLLM now returns per-field objects. `fv` builds one;
// `fvMap` converts a {field: value} record into the new {field: {value,...}} shape.
function fv(value: string, sourceUrl?: string, sourceQuote?: string) {
  const obj: { value: string; sourceUrl?: string; sourceQuote?: string } = { value };
  if (sourceUrl) obj.sourceUrl = sourceUrl;
  if (sourceQuote) obj.sourceQuote = sourceQuote;
  return obj;
}
```

Then add a new `describe` block at the end of the file:

```typescript
describe('runWaterfall — web-tier per-field provenance (Fix 1)', () => {
  it('FAIL CASE: a web-tier fill carries provider llm_web_search', async () => {
    const deps = makeDeps({
      fetchWebForGroup: jest.fn().mockResolvedValue({ webContext: 'Acme is a SaaS company.' }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({
        filled: { company_description: fv('A SaaS company') },
        missing: [],
      }),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'company_firmographic', requestedFields: ['company_description'] }),
      deps,
    );
    const fill = result.fields.find(f => f.field === 'company_description');
    expect(fill?.meta.source).toBe('web_search');
    expect(fill?.meta.provider).toBe('llm_web_search');
  });

  it('FAIL CASE: a web-tier fill carries the sourceUrl returned by the LLM', async () => {
    const deps = makeDeps({
      fetchWebForGroup: jest.fn().mockResolvedValue({ webContext: 'ctx' }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({
        filled: { company_description: fv('A SaaS company', 'https://acme.com/about') },
        missing: [],
      }),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'company_firmographic', requestedFields: ['company_description'] }),
      deps,
    );
    const fill = result.fields.find(f => f.field === 'company_description');
    expect(fill?.meta.sourceUrl).toBe('https://acme.com/about');
  });

  it('FAIL CASE: a web-tier fill carries the sourceQuote returned by the LLM', async () => {
    const deps = makeDeps({
      fetchWebForGroup: jest.fn().mockResolvedValue({ webContext: 'ctx' }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({
        filled: { company_description: fv('A SaaS company', undefined, 'Acme builds SaaS for teams') },
        missing: [],
      }),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'company_firmographic', requestedFields: ['company_description'] }),
      deps,
    );
    const fill = result.fields.find(f => f.field === 'company_description');
    expect(fill?.meta.sourceQuote).toBe('Acme builds SaaS for teams');
  });

  it('SUCCESS CASE: a web-tier fill with no URL/quote still produces a valued fill', async () => {
    const deps = makeDeps({
      fetchWebForGroup: jest.fn().mockResolvedValue({ webContext: 'ctx' }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({
        filled: { company_description: fv('A SaaS company') },
        missing: [],
      }),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'company_firmographic', requestedFields: ['company_description'] }),
      deps,
    );
    const fill = result.fields.find(f => f.field === 'company_description');
    expect(fill?.value).toBe('A SaaS company');
    expect(fill?.meta.sourceUrl).toBeUndefined();
    expect(fill?.meta.sourceQuote).toBeUndefined();
  });
});
```

- [ ] **Step 2: Migrate the 15 existing `filled` mocks to the new shape**

The existing `extractFieldsViaLLM` mocks in `enrichmentWaterfall.v3.test.ts` return bare strings. Update each so every value inside `filled: { ... }` is wrapped in `fv(...)`. Apply these exact replacements:

Line 53 — the `makeDeps` default. Replace:
```typescript
    extractFieldsViaLLM: jest.fn().mockResolvedValue({ filled: {}, missing: [] }),
```
with (empty `filled` is already valid for the new type — no change needed). **Leave line 53 as-is.**

Replace `filled: { recent_news: 'launched product Y' }, missing: [],` with:
```typescript
        filled: { recent_news: fv('launched product Y') }, missing: [],
```

Replace `filled: { tech_stack: 'AWS, HubSpot, Stripe' },` with:
```typescript
        filled: { tech_stack: fv('AWS, HubSpot, Stripe') },
```

Replace `filled: { tech_stack: 'AWS' }, missing: [],` with:
```typescript
        filled: { tech_stack: fv('AWS') }, missing: [],
```

Replace `filled: { crm_used: 'HubSpot' }, missing: [],` with:
```typescript
        filled: { crm_used: fv('HubSpot') }, missing: [],
```

Replace `filled: { company_name: 'Acme', industry: 'SaaS', employee_count: '500' },` with:
```typescript
        filled: { company_name: fv('Acme'), industry: fv('SaaS'), employee_count: fv('500') },
```

Replace `filled: { company_name: 'Acme' },` (line ~376) with:
```typescript
        filled: { company_name: fv('Acme') },
```

Replace `filled: { company_name: 'Acme' }, missing: [],` (line ~548) with:
```typescript
        filled: { company_name: fv('Acme') }, missing: [],
```

Replace `filled: { company_description: 'A SaaS company', employee_count: '42' },` with:
```typescript
        filled: { company_description: fv('A SaaS company'), employee_count: fv('42') },
```

Replace `extractFieldsViaLLM: jest.fn().mockResolvedValue({ filled: { company_description: 'from web' }, missing: [] }),` with:
```typescript
      extractFieldsViaLLM: jest.fn().mockResolvedValue({ filled: { company_description: fv('from web') }, missing: [] }),
```

Replace `extractFieldsViaLLM: jest.fn().mockResolvedValue({ filled: { company_description: '' }, missing: [] }),` with:
```typescript
      extractFieldsViaLLM: jest.fn().mockResolvedValue({ filled: { company_description: fv('') }, missing: [] }),
```

Replace `filled: { company_description: 'A company' },` with:
```typescript
        filled: { company_description: fv('A company') },
```

The two `filled: {}, missing: ['x']` lines (~568, ~599) and the `filled: {}, missing: ['company_description']` line (~766) need no change — an empty object satisfies `Record<string, LLMFilledValue>`.

> **Note:** after the type change in Step 3, `npx jest` will surface any mock you missed as a TypeScript error. Run `grep -n "filled: {" backend/src/__tests__/enrichmentWaterfall.v3.test.ts` and verify every non-empty `filled` literal uses `fv(...)`.

- [ ] **Step 3: Change `LLMExtractResult` and add `LLMFilledValue` in `enrichmentGroupWaterfall.ts`**

In `backend/src/services/enrichmentGroupWaterfall.ts`, the type currently reads (~lines 104-107):

```typescript
export interface LLMExtractResult {
  filled: Record<string, string>;
  missing: string[];
}
```

Replace with:

```typescript
/** One LLM-extracted field value plus its web provenance (web tier only —
 *  Apollo-tier values are normalized into this shape with no URL/quote). */
export interface LLMFilledValue {
  value: string;
  sourceUrl?: string;
  sourceQuote?: string;
}

export interface LLMExtractResult {
  filled: Record<string, LLMFilledValue>;
  missing: string[];
}
```

- [ ] **Step 4: Update `metaWeb()` in `enrichmentGroupWaterfall.ts`**

`metaWeb` currently reads (~lines 202-207):

```typescript
function metaWeb(): EnrichedFieldMeta {
  return {
    source: 'web_search',
    enrichedAt: new Date().toISOString(),
  };
}
```

Replace with (Fix 1 adds `provider`/`sourceUrl`/`sourceQuote`; the `confidence:'medium'` here is also part of Fix 6 — included now so `metaWeb` is touched once):

```typescript
function metaWeb(sourceUrl?: string, sourceQuote?: string): EnrichedFieldMeta {
  return {
    source: 'web_search',
    provider: 'llm_web_search',
    confidence: 'medium',
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(sourceQuote ? { sourceQuote } : {}),
    enrichedAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 5: Update the three `extractFieldsViaLLM` consumer call sites in `enrichmentGroupWaterfall.ts`**

**(a) Tier 3 — Apollo reader (~lines 308-315).** Currently:

```typescript
    for (const f of tier3Targets) {
      const value = llmResult.filled[f];
      if (typeof value === 'string' && value.length > 0) {
        filled.push({ field: f, value, meta: metaApollo() });
        tier3Fills += 1;
      }
    }
    remaining = remaining.filter(f => !llmResult.filled[f]);
```

Replace with — read `.value` from the new object shape, and keep `metaApollo()` with **no argument**. Task 7 (Fix 6) changes the `metaApollo` signature to take a `field` argument and updates this call site then; keeping it argument-less here means PR A compiles on its own:

```typescript
    for (const f of tier3Targets) {
      const entry = llmResult.filled[f];
      if (entry && typeof entry.value === 'string' && entry.value.length > 0) {
        filled.push({ field: f, value: entry.value, meta: metaApollo() });
        tier3Fills += 1;
      }
    }
    remaining = remaining.filter(f => !llmResult.filled[f]);
```

**(b) Tier 3.5c — Unipile-company reader (~lines 411-418).** Currently:

```typescript
      for (const f of remaining) {
        const value = llmResult.filled[f];
        if (typeof value === 'string' && value.length > 0) {
          filled.push({ field: f, value, meta: metaUnipile() });
          unipileCompanyFills += 1;
        }
      }
      remaining = remaining.filter(f => !llmResult.filled[f]);
```

Replace with:

```typescript
      for (const f of remaining) {
        const entry = llmResult.filled[f];
        if (entry && typeof entry.value === 'string' && entry.value.length > 0) {
          filled.push({ field: f, value: entry.value, meta: metaUnipile() });
          unipileCompanyFills += 1;
        }
      }
      remaining = remaining.filter(f => !llmResult.filled[f]);
```

**(c) Tier 4 — Web reader (~lines 447-454).** Currently:

```typescript
    for (const f of remaining) {
      const value = llmResult.filled[f];
      if (typeof value === 'string' && value.length > 0) {
        filled.push({ field: f, value, meta: metaWeb() });
        webFills += 1;
      }
    }
    remaining = remaining.filter(f => !llmResult.filled[f]);
```

Replace with:

```typescript
    for (const f of remaining) {
      const entry = llmResult.filled[f];
      if (entry && typeof entry.value === 'string' && entry.value.length > 0) {
        filled.push({ field: f, value: entry.value, meta: metaWeb(entry.sourceUrl, entry.sourceQuote) });
        webFills += 1;
      }
    }
    remaining = remaining.filter(f => !llmResult.filled[f]);
```

- [ ] **Step 6: Verify compilation after the group-waterfall edits**

Run: `npx tsc`
Expected: errors ONLY in `enrichmentV3RealDeps.ts` (its `extractFieldsViaLLMReal` still returns the old shape, which no longer satisfies `WaterfallDeps.extractFieldsViaLLM`). That confirms Step 5 is wired; proceed to Step 7.

- [ ] **Step 7: Update `rejectHallucinatedLinkedInUrls` in `enrichmentV3RealDeps.ts`**

It currently operates on `Record<string,string>` (~lines 441-460):

```typescript
export function rejectHallucinatedLinkedInUrls(filled: Record<string, string>, sourceContext: string): Record<string, string> {
  const normalizedSource = sourceContext.toLowerCase().replace(/\s+/g, ' ').trim();
  const result: Record<string, string> = {};
  for (const [field, value] of Object.entries(filled)) {
    if (/linkedin/i.test(field)) {
      const slugMatch = value.match(/linkedin\.com\/(in|company)\/([^/?#\s]+)/i);
      if (!slugMatch) {
        console.warn(`[v3 deps] Rejected LinkedIn URL "${value}" for field "${field}" — no valid /in/ or /company/ path`);
        continue;
      }
      const slug = slugMatch[2].toLowerCase();
      if (!normalizedSource.includes(slug)) {
        console.warn(`[v3 deps] Rejected hallucinated LinkedIn URL "${value}" for field "${field}" — slug "${slug}" not in source data`);
        continue;
      }
    }
    result[field] = value;
  }
  return result;
}
```

Replace with (operates on the object shape — `value` becomes `entry.value`):

```typescript
export function rejectHallucinatedLinkedInUrls(
  filled: Record<string, LLMFilledValue>,
  sourceContext: string,
): Record<string, LLMFilledValue> {
  const normalizedSource = sourceContext.toLowerCase().replace(/\s+/g, ' ').trim();
  const result: Record<string, LLMFilledValue> = {};
  for (const [field, entry] of Object.entries(filled)) {
    if (/linkedin/i.test(field)) {
      const slugMatch = entry.value.match(/linkedin\.com\/(in|company)\/([^/?#\s]+)/i);
      if (!slugMatch) {
        console.warn(`[v3 deps] Rejected LinkedIn URL "${entry.value}" for field "${field}" — no valid /in/ or /company/ path`);
        continue;
      }
      const slug = slugMatch[2].toLowerCase();
      if (!normalizedSource.includes(slug)) {
        console.warn(`[v3 deps] Rejected hallucinated LinkedIn URL "${entry.value}" for field "${field}" — slug "${slug}" not in source data`);
        continue;
      }
    }
    result[field] = entry;
  }
  return result;
}
```

Then add `LLMFilledValue` to the existing `enrichmentGroupWaterfall` import. The current import line reads:

```typescript
import { runWaterfall as pureRunWaterfall } from './enrichmentGroupWaterfall';
```

Replace with:

```typescript
import { runWaterfall as pureRunWaterfall, type LLMFilledValue } from './enrichmentGroupWaterfall';
```

- [ ] **Step 8: Update `extractFieldsViaLLMReal` in `enrichmentV3RealDeps.ts`**

The function currently reads (~lines 462-527):

```typescript
async function extractFieldsViaLLMReal(input: {
  tier: 'apollo' | 'web';
  sourceContext: string;
  fields: string[];
  groupName: string;
  lead: LeadRecord;
  configFieldsByName: Record<string, { instruction?: string } | undefined>;
}): Promise<{ filled: Record<string, string>; missing: string[] }> {
  if (input.fields.length === 0) return { filled: {}, missing: [] };

  const fieldGuide = buildFieldGuidanceV3(input.fields, input.configFieldsByName);

  const leadContext = JSON.stringify({
    email: input.lead.email,
    company: input.lead.company,
    website: input.lead.website,
    firstName: input.lead.firstName,
    lastName: input.lead.lastName,
  });

  const isWebTier = input.tier === 'web';

  const systemPrompt = isWebTier
    ? `You extract structured CRM data for a given lead. Follow this priority order:\n` +
      `1. Extract from the provided web context if the information is clearly present.\n` +
      `2. If information is missing or insufficient, use your web search capability to look it up.\n` +
      `3. If web search yields no result, use your own training knowledge if you are FULLY confident.\n` +
      `4. If you do not know a value with confidence, return null for that field.\n` +
      `NEVER guess, infer, or fabricate. Return strict JSON only, strings only, no markdown.`
    : `You extract structured CRM data from the provided context. Return strict JSON: ` +
      `an object with one key per requested field. Use null when the value isn't ` +
      `explicitly present. Do NOT infer or fabricate. Strings only, no markdown.`;

  const userPrompt =
    `Lead: ${leadContext}\n\n` +
    `Source (${input.tier}):\n${input.sourceContext.slice(0, 16000)}\n\n` +
    `Extract these fields (return one JSON object with these exact keys):\n${fieldGuide}\n\n` +
    `Return ONLY a JSON object like {"field_name": "value", "other_field": null}. No prose.`;

  try {
    let parsed: Record<string, any>;
    if (isWebTier) {
      const llm = createLLMService(WEB_SEARCH_MODEL, 0.0);
      parsed = await llm.generateJSONContentWithWebSearch<Record<string, any>>(systemPrompt, userPrompt);
    } else {
      const llm = createLLMService(EXTRACT_MODEL, 0.0);
      parsed = await llm.generateJSONContent<Record<string, any>>(systemPrompt, userPrompt);
    }
    const filled: Record<string, string> = {};
    const missing: string[] = [];
    for (const field of input.fields) {
      const value = parsed?.[field];
      if (value != null && String(value).trim().length > 0 && String(value).toLowerCase() !== 'null') {
        filled[field] = String(value).trim();
      } else {
        missing.push(field);
      }
    }
    const verified = rejectHallucinatedLinkedInUrls(filled, input.sourceContext);
    const verifiedMissing = input.fields.filter(f => !(f in verified));
    return { filled: verified, missing: [...new Set([...missing, ...verifiedMissing])] };
  } catch (err) {
    console.warn('[v3 deps] extractFieldsViaLLM failed:', (err as Error).message);
    return { filled: {}, missing: input.fields };
  }
}
```

Replace the whole function with (web tier asks for the `{value,sourceUrl,sourceQuote}` shape; Apollo tier keeps the bare-string prompt and normalizes internally):

```typescript
async function extractFieldsViaLLMReal(input: {
  tier: 'apollo' | 'web';
  sourceContext: string;
  fields: string[];
  groupName: string;
  lead: LeadRecord;
  configFieldsByName: Record<string, { instruction?: string } | undefined>;
}): Promise<{ filled: Record<string, LLMFilledValue>; missing: string[] }> {
  if (input.fields.length === 0) return { filled: {}, missing: [] };

  const fieldGuide = buildFieldGuidanceV3(input.fields, input.configFieldsByName);

  const leadContext = JSON.stringify({
    email: input.lead.email,
    company: input.lead.company,
    website: input.lead.website,
    firstName: input.lead.firstName,
    lastName: input.lead.lastName,
  });

  const isWebTier = input.tier === 'web';

  // Web tier asks for per-field provenance objects so the value carries the
  // sourceUrl / sourceQuote the critic and provenance UI need. Apollo tier
  // keeps the bare-string prompt (Apollo JSON has no URLs) and the bare result
  // is normalized into the unified {value} shape below.
  const systemPrompt = isWebTier
    ? `You extract structured CRM data for a given lead. Follow this priority order:\n` +
      `1. Extract from the provided web context if the information is clearly present.\n` +
      `2. If information is missing or insufficient, use your web search capability to look it up.\n` +
      `3. If web search yields no result, use your own training knowledge if you are FULLY confident.\n` +
      `4. If you do not know a value with confidence, return null for that field.\n` +
      `NEVER guess, infer, or fabricate. For each field return an object ` +
      `{"value": <string>, "sourceUrl": <url or null>, "sourceQuote": <short verbatim snippet or null>}. ` +
      `Return strict JSON only, no markdown.`
    : `You extract structured CRM data from the provided context. Return strict JSON: ` +
      `an object with one key per requested field. Use null when the value isn't ` +
      `explicitly present. Do NOT infer or fabricate. Strings only, no markdown.`;

  const userPrompt = isWebTier
    ? `Lead: ${leadContext}\n\n` +
      `Source (${input.tier}):\n${input.sourceContext.slice(0, 16000)}\n\n` +
      `Extract these fields (return one JSON object with these exact keys):\n${fieldGuide}\n\n` +
      `Return ONLY a JSON object like ` +
      `{"field_name": {"value": "...", "sourceUrl": "...", "sourceQuote": "..."}, "other_field": null}. No prose.`
    : `Lead: ${leadContext}\n\n` +
      `Source (${input.tier}):\n${input.sourceContext.slice(0, 16000)}\n\n` +
      `Extract these fields (return one JSON object with these exact keys):\n${fieldGuide}\n\n` +
      `Return ONLY a JSON object like {"field_name": "value", "other_field": null}. No prose.`;

  try {
    let parsed: Record<string, any>;
    if (isWebTier) {
      const llm = createLLMService(WEB_SEARCH_MODEL, 0.0);
      parsed = await llm.generateJSONContentWithWebSearch<Record<string, any>>(systemPrompt, userPrompt);
    } else {
      const llm = createLLMService(EXTRACT_MODEL, 0.0);
      parsed = await llm.generateJSONContent<Record<string, any>>(systemPrompt, userPrompt);
    }
    const filled: Record<string, LLMFilledValue> = {};
    const missing: string[] = [];
    for (const field of input.fields) {
      const raw = parsed?.[field];
      // Web tier returns objects; Apollo tier returns bare strings. Normalize
      // both into LLMFilledValue. A web-tier null/empty value → missing.
      let entry: LLMFilledValue | null = null;
      if (raw != null) {
        if (isWebTier && typeof raw === 'object' && !Array.isArray(raw)) {
          const v = raw.value;
          if (v != null && String(v).trim().length > 0 && String(v).toLowerCase() !== 'null') {
            entry = { value: String(v).trim() };
            if (typeof raw.sourceUrl === 'string' && raw.sourceUrl.trim() && raw.sourceUrl.toLowerCase() !== 'null') {
              entry.sourceUrl = raw.sourceUrl.trim();
            }
            if (typeof raw.sourceQuote === 'string' && raw.sourceQuote.trim() && raw.sourceQuote.toLowerCase() !== 'null') {
              entry.sourceQuote = trimQuote(raw.sourceQuote) ?? undefined;
            }
          }
        } else if (String(raw).trim().length > 0 && String(raw).toLowerCase() !== 'null') {
          entry = { value: String(raw).trim() };
        }
      }
      if (entry) {
        filled[field] = entry;
      } else {
        missing.push(field);
      }
    }
    const verified = rejectHallucinatedLinkedInUrls(filled, input.sourceContext);
    const verifiedMissing = input.fields.filter(f => !(f in verified));
    return { filled: verified, missing: [...new Set([...missing, ...verifiedMissing])] };
  } catch (err) {
    console.warn('[v3 deps] extractFieldsViaLLM failed:', (err as Error).message);
    return { filled: {}, missing: input.fields };
  }
}
```

Then add the `trimQuote` import. The existing `../utils/enrichedFieldValue` is not currently imported in this file — add a new import line near the other imports (after the `import { FIELD_GROUPS } from './enrichmentGroups';` line):

```typescript
import { trimQuote } from '../utils/enrichedFieldValue';
```

> **Check first:** run `grep -n "enrichedFieldValue" backend/src/services/enrichmentV3RealDeps.ts`. If a `from '../utils/enrichedFieldValue'` import already exists, add `trimQuote` to it instead of creating a new line.

- [ ] **Step 9: Update the ungrouped web extractor in `enrichmentV3RealDeps.ts`**

The ungrouped extractor reads `llmResult.filled[field]` as a string (~lines 824-833):

```typescript
      const filled: any[] = [];
      for (const field of fields) {
        const value = llmResult.filled[field];
        if (typeof value === 'string' && value.length > 0) {
          filled.push({
            field, value,
            meta: { source: 'web_search', enrichedAt: new Date().toISOString() },
          });
        }
      }
```

Replace with (read `.value`; stamp the same provider/URL/quote as `metaWeb`):

```typescript
      const filled: any[] = [];
      for (const field of fields) {
        const entry = llmResult.filled[field];
        if (entry && typeof entry.value === 'string' && entry.value.length > 0) {
          filled.push({
            field,
            value: entry.value,
            meta: {
              source: 'web_search',
              provider: 'llm_web_search',
              confidence: 'medium',
              ...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}),
              ...(entry.sourceQuote ? { sourceQuote: entry.sourceQuote } : {}),
              enrichedAt: new Date().toISOString(),
            },
          });
        }
      }
```

- [ ] **Step 10: Verify compilation and tests**

Run: `npx tsc`
Expected: no errors. (`extractFieldsViaLLMReal` now returns `Record<string,LLMFilledValue>`, satisfying `WaterfallDeps.extractFieldsViaLLM`; `rejectHallucinatedLinkedInUrls` operates on the object shape; the ungrouped extractor reads `.value`.)

Run: `npx jest enrichmentWaterfall.v3 enrichmentV3RealDeps`
Expected: PASS — the 15 migrated mocks compile and the four new Fix 1 tests pass.

Run: `npx jest crmEnrichmentServiceV3`
Expected: PASS — the orchestrator only sees `FieldFill` objects (`{field,value,meta}`), unaffected by the `LLMExtractResult` change.

- [ ] **Step 11: Commit**

```bash
git add backend/src/services/enrichmentGroupWaterfall.ts backend/src/services/enrichmentV3RealDeps.ts backend/src/__tests__/enrichmentWaterfall.v3.test.ts
git commit -m "feat(enrichment): record per-field web provenance on v3 web-tier fills"
```

---

# PR B — Backend: Presentation (stacked on PR A)

PR B bundles Fixes 5 and 6 (Tasks 6-7) plus the release note (Task 8). Fix 5 needs Fix 1's source quotes for the critic to produce sane verdicts; Fix 6 edits `metaWeb()`/`makeApiMeta()`, also edited by Fixes 1/2 — so PR B must land after PR A.

**Before starting Task 6** — with all of PR A (Tasks 1-5) committed on `harshit/v3-enrichment-source-attribution-fixes` — create the stacked PR B branch from its tip:

```bash
git checkout -b harshit/v3-enrichment-critic-view
```

Tasks 6-8 commit on this branch. PR B is opened with `harshit/v3-enrichment-source-attribution-fixes` as its base (so its diff shows only Tasks 6-8); after PR A merges to `main`, retarget PR B's base to `main`.

---

### Task 6 — Fix 5: Critic verdict surfacing (`criticView`)

The Step 3 critic in `crmEnrichmentServiceV3.ts` stamps a 4-value `meta.criticVerdict` on each web-tier fill but never exposes it as an actionable signal. Add a `criticView?: 'drop' | 'low' | 'high'` field to `EnrichedFieldMeta` and, right after the critic stamps `criticVerdict`, derive `criticView`:

| `criticVerdict` | `criticView` |
|---|---|
| `contradicted` | `drop` |
| `unsupported`, `partially-supported` | `low` |
| `supported` | `high` |

Purely additive — no fill is dropped, downgraded, or mutated. Web-tier fills only (the critic checks web fills only — see the Tier-3 note in the spec).

**Files:**
- Modify: `backend/src/utils/enrichedFieldValue.ts` (add `criticView?` to `EnrichedFieldMeta`)
- Modify: `backend/src/services/crmEnrichmentServiceV3.ts` (the critic loop ~lines 535-540)
- Test: `backend/src/__tests__/crmEnrichmentServiceV3.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `backend/src/__tests__/crmEnrichmentServiceV3.test.ts`, as a new `describe` block at the end of the file:

```typescript
describe('runEnrichment — critic view derivation (Fix 5)', () => {
  // The critic runs over web-tier fills. After it stamps criticVerdict, the
  // orchestrator derives criticView: contradicted→drop, unsupported/
  // partially-supported→low, supported→high. Nothing is dropped or mutated.

  function webFillDeps(verdicts: Record<string, string>) {
    return makeDeps({
      loadLeads: jest.fn().mockResolvedValue([makeLead({ leadId: 'lead-1' })]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{
          field: 'company_description',
          value: 'A SaaS company',
          meta: { source: 'web_search', provider: 'llm_web_search', enrichedAt: '2026-01-01T00:00:00Z' },
        }],
        missing: [],
        tierFills: { crm: 0, apollo: 0, web: 1, missing: 0 },
      }),
      runCriticOverWebFills: jest.fn().mockResolvedValue({ verdicts }),
      setLeadFields: jest.fn().mockResolvedValue(undefined),
    });
  }

  const cfg = makeConfig({
    fields: [{ name: 'company_description', type: 'string', instruction: 'desc', include: true, overwritePolicy: 'always_overwrite' }],
  });

  it('FAIL CASE: a contradicted verdict derives criticView "drop"', async () => {
    const deps = webFillDeps({ company_description: 'contradicted' });
    await runEnrichment(makeInput({ config: cfg }), deps);
    const meta = (deps.setLeadFields as jest.Mock).mock.calls[0][0].enrichmentMetadata.company_description;
    expect(meta.criticVerdict).toBe('contradicted');
    expect(meta.criticView).toBe('drop');
  });

  it('FAIL CASE: an unsupported verdict derives criticView "low"', async () => {
    const deps = webFillDeps({ company_description: 'unsupported' });
    await runEnrichment(makeInput({ config: cfg }), deps);
    const meta = (deps.setLeadFields as jest.Mock).mock.calls[0][0].enrichmentMetadata.company_description;
    expect(meta.criticView).toBe('low');
  });

  it('FAIL CASE: a partially-supported verdict derives criticView "low"', async () => {
    const deps = webFillDeps({ company_description: 'partially-supported' });
    await runEnrichment(makeInput({ config: cfg }), deps);
    const meta = (deps.setLeadFields as jest.Mock).mock.calls[0][0].enrichmentMetadata.company_description;
    expect(meta.criticView).toBe('low');
  });

  it('SUCCESS CASE: a supported verdict derives criticView "high" and the fill is still persisted', async () => {
    const deps = webFillDeps({ company_description: 'supported' });
    await runEnrichment(makeInput({ config: cfg }), deps);
    const call = (deps.setLeadFields as jest.Mock).mock.calls[0][0];
    expect(call.topLevel?.company_description ?? call.customFields?.company_description).toBe('A SaaS company');
    expect(call.enrichmentMetadata.company_description.criticView).toBe('high');
  });

  it('SUCCESS CASE: a fill with no critic verdict has no criticView', async () => {
    const deps = webFillDeps({});  // critic returns no verdict for the field
    await runEnrichment(makeInput({ config: cfg }), deps);
    const meta = (deps.setLeadFields as jest.Mock).mock.calls[0][0].enrichmentMetadata.company_description;
    expect(meta.criticVerdict).toBeUndefined();
    expect(meta.criticView).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest crmEnrichmentServiceV3 -t "critic view derivation"`
Expected: FAIL — the three FAIL-CASE tests and the first SUCCESS CASE fail because `criticView` is never set. The "no critic verdict" SUCCESS CASE passes already.
Note: the FAIL-CASE tests will also fail to compile against `EnrichedFieldMeta` (`criticView` is not yet a field) — that is expected; Step 3 adds the field.

- [ ] **Step 3: Add `criticView` to `EnrichedFieldMeta`**

In `backend/src/utils/enrichedFieldValue.ts`, the interface currently ends (~lines 46-50):

```typescript
  /** Critic verdict from item #6 critic pass, if it ran. */
  criticVerdict?: 'supported' | 'partially-supported' | 'unsupported' | 'contradicted';
  /** Normalized form of the value (e.g. enum, numeric range) when a type spec recognizes the field. */
  normalized?: string | number | { min: number; max: number } | null;
}
```

Replace with:

```typescript
  /** Critic verdict from item #6 critic pass, if it ran. */
  criticVerdict?: 'supported' | 'partially-supported' | 'unsupported' | 'contradicted';
  /**
   * Actionable per-field quality view derived from `criticVerdict` for
   * web-sourced fields. Advisory only — a `drop` view recommends removal but
   * the value is never auto-deleted.
   *  - 'drop' ← contradicted
   *  - 'low'  ← unsupported / partially-supported
   *  - 'high' ← supported
   */
  criticView?: 'drop' | 'low' | 'high';
  /** Normalized form of the value (e.g. enum, numeric range) when a type spec recognizes the field. */
  normalized?: string | number | { min: number; max: number } | null;
}
```

- [ ] **Step 4: Derive `criticView` in the critic loop**

In `backend/src/services/crmEnrichmentServiceV3.ts`, the critic loop currently reads (~lines 535-540):

```typescript
      for (const fill of webFills) {
        const verdict = criticResult.verdicts[fill.field];
        if (verdict) {
          fill.meta = { ...fill.meta, criticVerdict: verdict };
        }
      }
```

Replace with:

```typescript
      for (const fill of webFills) {
        const verdict = criticResult.verdicts[fill.field];
        if (verdict) {
          // Derive an actionable per-field quality view from the verdict.
          // Advisory only — `drop` recommends removal but nothing is auto-deleted.
          const criticView: EnrichedFieldMeta['criticView'] =
            verdict === 'contradicted' ? 'drop' :
            verdict === 'supported' ? 'high' :
            'low';   // unsupported / partially-supported
          fill.meta = { ...fill.meta, criticVerdict: verdict, criticView };
        }
      }
```

(`EnrichedFieldMeta` is already imported in `crmEnrichmentServiceV3.ts` — line 21.)

- [ ] **Step 5: Verify compilation and tests**

Run: `npx tsc`
Expected: no errors.

Run: `npx jest crmEnrichmentServiceV3 enrichmentMetadataPresentation`
Expected: PASS — all five new tests pass; `enrichmentMetadataPresentation` covers the response sanitizer and must still pass (no key removed).

- [ ] **Step 6: Commit**

```bash
git add backend/src/utils/enrichedFieldValue.ts backend/src/services/crmEnrichmentServiceV3.ts backend/src/__tests__/crmEnrichmentServiceV3.test.ts
git commit -m "feat(enrichment): surface critic verdict as a per-field criticView"
```

---

### Task 7 — Fix 6: Confidence restoration

Wire the existing `getFieldConfidence()` registry into V3 so every enriched field carries a `confidence` label. Four meta builders change:

- **`metaApollo(field, opts?)`** (group waterfall) → `confidence: getFieldConfidence('apollo', field)`. Tier 2 (deterministic) uses the raw value; Tier 3 (LLM over Apollo JSON) passes `{ llmExtracted: true }` → one-notch downgrade (`high→medium`, `medium→low`, `low→low`).
- **`makeApiMeta(provider, field?)`** (identity resolver) → `getFieldConfidence` for `apollo`/`enrich.so`; `unipile`/`pattern` → `'medium'`. The two reuse-across-fields call sites (`apolloMeta` ~:343, `enrichSoMeta` ~:514) must call `makeApiMeta` **per field**.
- **`metaUnipile()`** (group waterfall) → `confidence:'medium'`.
- **`metaWeb()`** → already gained `confidence:'medium'` in Task 5 — no change here.
- **Extend `APOLLO_FIELD_CONFIDENCE`** in `fieldConfidenceRegistry.ts` with identity fields.

> `metaWeb()` already carries `confidence:'medium'` from Task 5 Step 4 — do not edit it again.

**Files:**
- Modify: `backend/src/services/fieldConfidenceRegistry.ts` (extend `APOLLO_FIELD_CONFIDENCE`)
- Modify: `backend/src/services/enrichmentGroupWaterfall.ts` (`metaApollo`, `metaUnipile`, the two `metaApollo()` call sites)
- Modify: `backend/src/services/enrichmentIdentityResolver.ts` (`makeApiMeta` + per-field call sites)
- Test: `backend/src/__tests__/fieldConfidenceRegistry.test.ts`, `backend/src/__tests__/enrichmentWaterfall.v3.test.ts`, `backend/src/__tests__/enrichmentIdentityResolver.test.ts`

- [ ] **Step 1: Write the failing registry test**

Add to `backend/src/__tests__/fieldConfidenceRegistry.test.ts`, as a new `describe` block at the end of the file:

```typescript
describe('APOLLO_FIELD_CONFIDENCE — identity fields (Fix 6)', () => {
  it('FAIL CASE: rates apollo firstName as high', () => {
    expect(getFieldConfidence('apollo', 'firstName')).toBe('high');
  });
  it('FAIL CASE: rates apollo email as high', () => {
    expect(getFieldConfidence('apollo', 'email')).toBe('high');
  });
  it('FAIL CASE: rates apollo company as medium', () => {
    expect(getFieldConfidence('apollo', 'company')).toBe('medium');
  });
  it('FAIL CASE: rates apollo title as medium', () => {
    expect(getFieldConfidence('apollo', 'title')).toBe('medium');
  });
  it('SUCCESS CASE: rates apollo lastName and linkedin high, phone medium', () => {
    expect(getFieldConfidence('apollo', 'lastName')).toBe('high');
    expect(getFieldConfidence('apollo', 'linkedin')).toBe('high');
    expect(getFieldConfidence('apollo', 'phone')).toBe('medium');
  });
});
```

> Check the top of `fieldConfidenceRegistry.test.ts` — if `getFieldConfidence` is not already imported, add `import { getFieldConfidence } from '../services/fieldConfidenceRegistry';`.

- [ ] **Step 2: Run the registry test to verify it fails**

Run: `npx jest fieldConfidenceRegistry -t "identity fields"`
Expected: FAIL — `firstName`/`email`/`lastName`/`linkedin` currently default to `'medium'` (not `'high'`); `company`/`title`/`phone` already return `'medium'` by default, so those three pass. The `firstName`/`email`/`lastName`/`linkedin` assertions fail.

- [ ] **Step 3: Extend `APOLLO_FIELD_CONFIDENCE`**

In `backend/src/services/fieldConfidenceRegistry.ts`, the table currently reads (~lines 44-58):

```typescript
const APOLLO_FIELD_CONFIDENCE: Record<string, Confidence> = {
  // Person fields (filled by applyApolloMatchToLead from /people/match)
  employmentHistory: 'medium',

  // Org fields (filled by apolloOrgEnrichmentSpecialists from match.organization)
  companyTechStack: 'medium',
  companyHeadcountGrowth6mo: 'medium',
  companyHeadcountGrowth12mo: 'medium',
  companyHeadcountGrowth24mo: 'medium',
  companyFundingTotal: 'high',
  companyFundingStage: 'high',
  companyFundingLastRoundDate: 'high',
  companyAnnualRevenue: 'low',          // estimate
  companyDepartmentHeadcount: 'low',    // estimate
};
```

Replace with (add the identity-field block):

```typescript
const APOLLO_FIELD_CONFIDENCE: Record<string, Confidence> = {
  // Identity fields (filled by the identity resolver / person waterfall).
  // 'high' for stable identifiers; 'medium' for current-state fields that
  // drift when the subject changes jobs. Listed explicitly so Apollo identity
  // fields no longer silently default to 'medium' while enrich.so rates the
  // same fields 'high'.
  firstName: 'high',
  lastName: 'high',
  email: 'high',
  linkedin: 'high',
  company: 'medium',
  title: 'medium',
  phone: 'medium',

  // Person fields (filled by applyApolloMatchToLead from /people/match)
  employmentHistory: 'medium',

  // Org fields (filled by apolloOrgEnrichmentSpecialists from match.organization)
  companyTechStack: 'medium',
  companyHeadcountGrowth6mo: 'medium',
  companyHeadcountGrowth12mo: 'medium',
  companyHeadcountGrowth24mo: 'medium',
  companyFundingTotal: 'high',
  companyFundingStage: 'high',
  companyFundingLastRoundDate: 'high',
  companyAnnualRevenue: 'low',          // estimate
  companyDepartmentHeadcount: 'low',    // estimate
};
```

- [ ] **Step 4: Verify the registry test passes**

Run: `npx tsc`
Expected: no errors.

Run: `npx jest fieldConfidenceRegistry`
Expected: PASS (all existing + the five new tests).

- [ ] **Step 5: Write the failing waterfall confidence tests**

Add to `backend/src/__tests__/enrichmentWaterfall.v3.test.ts`, as a new `describe` block at the end of the file:

```typescript
describe('runWaterfall — confidence on meta (Fix 6)', () => {
  it('FAIL CASE: a Tier 2 Apollo deterministic fill uses the raw registry confidence', async () => {
    // company_funding_total maps to companyFundingTotal=high in the registry...
    // but the waterfall fills by group field name. Use a field whose registry
    // entry is deterministic: total_funding is not in the registry → 'medium'.
    const deps = makeDeps({
      fetchApolloOrg: jest.fn().mockResolvedValue(apolloResult({ company_name: 'Acme' })),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'company_firmographic', requestedFields: ['company_name'] }),
      deps,
    );
    const fill = result.fields.find(f => f.field === 'company_name');
    // company_name is not in APOLLO_FIELD_CONFIDENCE → registry default 'medium'.
    expect(fill?.meta.confidence).toBe('medium');
  });

  it('FAIL CASE: a Tier 3 LLM-over-Apollo fill is downgraded one notch from the registry value', async () => {
    // funding_stage → registry has no 'funding_stage' key → default 'medium';
    // Tier-3 llmExtracted downgrade: medium → low.
    const deps = makeDeps({
      fetchApolloOrg: jest.fn().mockResolvedValue(apolloResult(
        { unrelated: 'x' },
        { name: 'Acme', latest_funding_stage: 'Series B' },
      )),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({
        filled: { funding_stage: fv('Series B') }, missing: [],
      }),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'company_financial', requestedFields: ['funding_stage'] }),
      deps,
    );
    const fill = result.fields.find(f => f.field === 'funding_stage');
    expect(fill?.meta.confidence).toBe('low');
  });

  it('FAIL CASE: a Unipile fill carries medium confidence', async () => {
    const deps = makeDeps({
      findLinkedInUrl: jest.fn().mockResolvedValue('https://www.linkedin.com/in/jane-doe'),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'person_identity', requestedFields: ['linkedin_url'] }),
      deps,
    );
    const fill = result.fields.find(f => f.field === 'linkedin_url');
    expect(fill?.meta.provider).toBe('unipile');
    expect(fill?.meta.confidence).toBe('medium');
  });

  it('SUCCESS CASE: a web-tier fill carries medium confidence', async () => {
    const deps = makeDeps({
      fetchWebForGroup: jest.fn().mockResolvedValue({ webContext: 'ctx' }),
      extractFieldsViaLLM: jest.fn().mockResolvedValue({
        filled: { company_description: fv('A SaaS company') }, missing: [],
      }),
    });
    const result = await runWaterfall(
      makeInput({ groupName: 'company_firmographic', requestedFields: ['company_description'] }),
      deps,
    );
    const fill = result.fields.find(f => f.field === 'company_description');
    expect(fill?.meta.confidence).toBe('medium');
  });
});
```

> **Note:** the SUCCESS CASE here already passes (Task 5 gave `metaWeb` `confidence:'medium'`). It is kept as a regression lock per the 1-success-case rule. The three FAIL CASEs fail because `metaApollo`/`metaUnipile` do not yet set `confidence`.

- [ ] **Step 6: Run the waterfall confidence tests to verify they fail**

Run: `npx jest enrichmentWaterfall.v3 -t "confidence on meta"`
Expected: FAIL on the three FAIL-CASE tests (`metaApollo()`/`metaUnipile()` set no `confidence` → `undefined`). The SUCCESS CASE passes.

- [ ] **Step 7: Update `metaApollo` and `metaUnipile` in `enrichmentGroupWaterfall.ts`**

`metaApollo` and `metaUnipile` currently read (~lines 194-215):

```typescript
function metaApollo(): EnrichedFieldMeta {
  return {
    source: 'api',
    provider: 'apollo',
    enrichedAt: new Date().toISOString(),
  };
}

function metaWeb(sourceUrl?: string, sourceQuote?: string): EnrichedFieldMeta {
  return {
    source: 'web_search',
    provider: 'llm_web_search',
    confidence: 'medium',
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(sourceQuote ? { sourceQuote } : {}),
    enrichedAt: new Date().toISOString(),
  };
}

function metaUnipile(): EnrichedFieldMeta {
  return {
    source: 'api',
    provider: 'unipile',
    enrichedAt: new Date().toISOString(),
  };
}
```

Replace the `metaApollo` and `metaUnipile` definitions (leave `metaWeb` untouched) so the block becomes:

```typescript
function metaApollo(field: string, opts?: { llmExtracted?: boolean }): EnrichedFieldMeta {
  // Tier 2 (deterministic direct-map) uses the raw registry confidence; Tier 3
  // (LLM extraction over Apollo raw JSON) passes { llmExtracted: true }, which
  // downgrades one notch — LLM extraction is less reliable than a direct map.
  let confidence = getFieldConfidence('apollo', field);
  if (opts?.llmExtracted) {
    confidence = confidence === 'high' ? 'medium' : confidence === 'medium' ? 'low' : 'low';
  }
  return {
    source: 'api',
    provider: 'apollo',
    confidence,
    enrichedAt: new Date().toISOString(),
  };
}

function metaWeb(sourceUrl?: string, sourceQuote?: string): EnrichedFieldMeta {
  return {
    source: 'web_search',
    provider: 'llm_web_search',
    confidence: 'medium',
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(sourceQuote ? { sourceQuote } : {}),
    enrichedAt: new Date().toISOString(),
  };
}

function metaUnipile(): EnrichedFieldMeta {
  return {
    source: 'api',
    provider: 'unipile',
    confidence: 'medium',
    enrichedAt: new Date().toISOString(),
  };
}
```

Then add the `getFieldConfidence` import. The current import block has:

```typescript
import { apolloEmailStatusToConfidence } from './apolloFieldMapper';
```

Add a new line immediately after it:

```typescript
import { getFieldConfidence } from './fieldConfidenceRegistry';
```

- [ ] **Step 8: Update the `metaApollo()` call sites in `enrichmentGroupWaterfall.ts`**

`metaApollo` now requires a `field` argument. Three call sites need updating:

**(a) Tier 2 Apollo direct-map (~line 275).** Currently:

```typescript
        apolloHits.push({ field: f, value, meta: metaApollo() });
```

Replace with:

```typescript
        apolloHits.push({ field: f, value, meta: metaApollo(f) });
```

**(b) Tier 3 LLM-over-Apollo (~line 311 — as left by Task 5 Step 5a).** Currently:

```typescript
        filled.push({ field: f, value: entry.value, meta: metaApollo() });
```

Replace with (Tier 3 → `llmExtracted: true`):

```typescript
        filled.push({ field: f, value: entry.value, meta: metaApollo(f, { llmExtracted: true }) });
```

**(c) Tier 3.5a Apollo broker chain (~line 357).** Currently:

```typescript
            meta: { ...metaApollo(), confidence: apolloEmailStatusToConfidence(brokerResult.emailStatus ?? '') },
```

Replace with (this fill is always the `email` field; the explicit `confidence` from the email status intentionally overrides the registry default):

```typescript
            meta: { ...metaApollo('email'), confidence: apolloEmailStatusToConfidence(brokerResult.emailStatus ?? '') },
```

> Tier 3.5c Unipile-company uses `metaUnipile()` — no argument, unchanged.

- [ ] **Step 9: Verify compilation after the group-waterfall edits**

Run: `npx tsc`
Expected: errors only in `enrichmentIdentityResolver.ts` are NOT expected here — `metaApollo` is module-local to the group waterfall. Expected: **no errors**. If `npx tsc` reports a `metaApollo` call with 0 args, you missed a call site — `grep -n "metaApollo(" backend/src/services/enrichmentGroupWaterfall.ts` should show exactly three calls, all with a `field` argument.

- [ ] **Step 10: Run the waterfall confidence tests**

Run: `npx jest enrichmentWaterfall.v3`
Expected: PASS — all four new confidence tests plus the migrated Fix 1 tests.

- [ ] **Step 11: Write the failing identity-resolver confidence tests**

Add to `backend/src/__tests__/enrichmentIdentityResolver.test.ts`, as a new `describe` block at the end of the file:

```typescript
describe('resolveIdentity — makeApiMeta per-field confidence (Fix 6)', () => {
  it('FAIL CASE: an Apollo-resolved firstName carries high confidence', async () => {
    const writeLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      apolloPeopleMatch: jest.fn().mockResolvedValue({
        firstName: 'Jane', lastName: 'Doe', company: 'Acme', email: 'jane@acme.com', emailStatus: 'verified',
      }),
      writeLeadFields,
    });
    await resolveIdentity(makeInput({
      lead: { leadId: LEAD_ID, email: 'jane@acme.com' },
      needsPersonFields: true,
    }), deps);
    const meta = (writeLeadFields as jest.Mock).mock.calls[0][0].meta;
    expect(meta.firstName.confidence).toBe('high');
  });

  it('FAIL CASE: an Apollo-resolved company carries medium confidence (per-field, not high)', async () => {
    const writeLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      apolloPeopleMatch: jest.fn().mockResolvedValue({
        firstName: 'Jane', lastName: 'Doe', company: 'Acme', email: 'jane@acme.com', emailStatus: 'verified',
      }),
      writeLeadFields,
    });
    await resolveIdentity(makeInput({
      lead: { leadId: LEAD_ID, email: 'jane@acme.com' },
      needsPersonFields: true,
      needsCompanyFields: true,
    }), deps);
    const meta = (writeLeadFields as jest.Mock).mock.calls[0][0].meta;
    expect(meta.company.confidence).toBe('medium');
    // The same Apollo result fills firstName at 'high' — proves per-field lookup.
    expect(meta.firstName.confidence).toBe('high');
  });

  it('FAIL CASE: an enrich.so reverse-lookup company carries medium confidence', async () => {
    const writeLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      enrichSoReverseLookup: jest.fn().mockResolvedValue({ company: 'Acme', firstName: 'Jane', lastName: 'Doe' }),
      writeLeadFields,
    });
    await resolveIdentity(makeInput({
      lead: { leadId: LEAD_ID, email: 'jane@personal.com' },
      needsCompanyFields: true,
    }), deps);
    const meta = (writeLeadFields as jest.Mock).mock.calls[0][0].meta;
    expect(meta.company.confidence).toBe('medium');
    // enrich.so rates firstName 'high' in the registry — per-field lookup proof.
    if (meta.firstName) expect(meta.firstName.confidence).toBe('high');
  });

  it('SUCCESS CASE: a Unipile-resolved linkedin carries medium confidence', async () => {
    const writeLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      findLinkedInUrl: jest.fn().mockResolvedValue('https://www.linkedin.com/in/jane-doe'),
      writeLeadFields,
    });
    await resolveIdentity(makeInput({
      lead: { leadId: LEAD_ID, firstName: 'Jane', lastName: 'Doe', company: 'Acme' },
      needsPersonFields: true,
    }), deps);
    const meta = (writeLeadFields as jest.Mock).mock.calls[0][0].meta;
    expect(meta.linkedin.confidence).toBe('medium');
  });
});
```

- [ ] **Step 12: Run the identity-resolver confidence tests to verify they fail**

Run: `npx jest enrichmentIdentityResolver -t "makeApiMeta per-field confidence"`
Expected: FAIL — `makeApiMeta` sets no `confidence` today, so every `meta.*.confidence` is `undefined`.

- [ ] **Step 13: Update `makeApiMeta` in `enrichmentIdentityResolver.ts`**

`makeApiMeta` currently reads (~lines 142-148):

```typescript
function makeApiMeta(provider: IdentityProvider): EnrichedFieldMeta {
  return {
    source: 'api',
    provider,
    enrichedAt: new Date().toISOString(),
  };
}
```

Replace with:

```typescript
function makeApiMeta(provider: IdentityProvider, field?: string): EnrichedFieldMeta {
  // Per-field confidence: apollo / enrich.so use the registry (so e.g.
  // enrich.so firstName='high' but company='medium'); unipile and pattern have
  // no registry entry and default to 'medium'. A missing field name also
  // defaults to 'medium'.
  let confidence: EnrichedFieldMeta['confidence'] = 'medium';
  if (field && (provider === 'apollo' || provider === 'enrich.so')) {
    confidence = getFieldConfidence(provider, field);
  }
  return {
    source: 'api',
    provider,
    confidence,
    enrichedAt: new Date().toISOString(),
  };
}
```

Then add the `getFieldConfidence` import. The current import block ends with:

```typescript
import { apolloEmailStatusToConfidence } from './apolloFieldMapper';
```

Add immediately after it:

```typescript
import { getFieldConfidence } from './fieldConfidenceRegistry';
```

- [ ] **Step 14: Update the `makeApiMeta` call sites in `enrichmentIdentityResolver.ts`**

Six call sites — each must pass the field name. Two of them (`apolloMeta`, `enrichSoMeta`) currently build one meta object reused across several fields and **must** become per-field calls.

**(a) Step 2.7 Unipile linkedin (~line 300).** Currently:

```typescript
        meta.linkedin = makeApiMeta('unipile');
```

Replace with:

```typescript
        meta.linkedin = makeApiMeta('unipile', 'linkedin');
```

**(b) Step 3 unified Apollo (~lines 343-385) — the reused `apolloMeta`.** Currently the block declares `const apolloMeta = makeApiMeta('apollo');` at line 343 and assigns it to `meta.firstName`, `meta.lastName`, `meta.title`, `meta.linkedin`, `meta.company`, `meta.website`, and spreads it into `meta.email`. Apply these edits:

- Delete the line `const apolloMeta = makeApiMeta('apollo');`.
- In the `meta.email` block, the spread currently reads:
  ```typescript
          meta.email = {
            ...apolloMeta,
            confidence: apolloEmailStatusToConfidence(apolloResult.emailStatus ?? ''),
          };
  ```
  Replace with (build the per-field apollo meta inline; the email-status confidence still overrides):
  ```typescript
          meta.email = {
            ...makeApiMeta('apollo', 'email'),
            confidence: apolloEmailStatusToConfidence(apolloResult.emailStatus ?? ''),
          };
  ```
- Replace each remaining `apolloMeta` assignment with a per-field call:
  ```typescript
            meta.firstName = apolloMeta;
  ```
  → `meta.firstName = makeApiMeta('apollo', 'firstName');`
  ```typescript
            meta.lastName = apolloMeta;
  ```
  → `meta.lastName = makeApiMeta('apollo', 'lastName');`
  ```typescript
            meta.title = apolloMeta;
  ```
  → `meta.title = makeApiMeta('apollo', 'title');`
  ```typescript
            meta.linkedin = apolloMeta;
  ```
  → `meta.linkedin = makeApiMeta('apollo', 'linkedin');`
  ```typescript
            meta.company = apolloMeta;
  ```
  → `meta.company = makeApiMeta('apollo', 'company');`
  ```typescript
            meta.website = apolloMeta;
  ```
  → `meta.website = makeApiMeta('apollo', 'website');`

**(c) Step 5.5 enrich.so email-finder (~line 413).** Currently:

```typescript
        meta.email = makeApiMeta('enrich.so');
```

Replace with:

```typescript
        meta.email = makeApiMeta('enrich.so', 'email');
```

**(d) Step 5.5 enrich.so reverse-lookup company (~line 420).** Currently:

```typescript
            meta.company = makeApiMeta('enrich.so');
```

Replace with:

```typescript
            meta.company = makeApiMeta('enrich.so', 'company');
```

**(e) Step 6.5 Apollo broker chain (~line 462).** Currently:

```typescript
        meta.email = {
          ...makeApiMeta('apollo'),
          confidence: apolloEmailStatusToConfidence(brokerResult.emailStatus ?? ''),
        };
```

Replace with:

```typescript
        meta.email = {
          ...makeApiMeta('apollo', 'email'),
          confidence: apolloEmailStatusToConfidence(brokerResult.emailStatus ?? ''),
        };
```

**(f) Step 6 enrich.so reverse-lookup (~lines 514-525) — the reused `enrichSoMeta`.** Currently the block declares `const enrichSoMeta = makeApiMeta('enrich.so');` at line 514 and assigns it to `meta.company`, `meta.firstName`, `meta.lastName`. Apply:

- Delete the line `const enrichSoMeta = makeApiMeta('enrich.so');`.
- Replace each `enrichSoMeta` assignment with a per-field call:
  ```typescript
            meta.company = enrichSoMeta;
  ```
  → `meta.company = makeApiMeta('enrich.so', 'company');`
  ```typescript
            meta.firstName = enrichSoMeta;
  ```
  → `meta.firstName = makeApiMeta('enrich.so', 'firstName');`
  ```typescript
            meta.lastName = enrichSoMeta;
  ```
  → `meta.lastName = makeApiMeta('enrich.so', 'lastName');`

> **Note on Tier 7 pattern email:** Task 3 already replaced that meta with an inline object (`provider:'pattern'`, `confidence:'medium'`) — it does not call `makeApiMeta`, so Fix 6 leaves it as-is. `'medium'` is already correct for `'pattern'`.

- [ ] **Step 15: Verify compilation and tests**

Run: `npx tsc`
Expected: no errors. `grep -n "makeApiMeta\|apolloMeta\|enrichSoMeta" backend/src/services/enrichmentIdentityResolver.ts` should show every `makeApiMeta` call with two arguments and NO remaining `apolloMeta`/`enrichSoMeta` local variables.

Run: `npx jest enrichmentIdentityResolver fieldConfidenceRegistry enrichmentWaterfall.v3 crmEnrichmentServiceV3`
Expected: PASS (all existing + every new Fix 6 test).

- [ ] **Step 16: Commit**

```bash
git add backend/src/services/fieldConfidenceRegistry.ts backend/src/services/enrichmentGroupWaterfall.ts backend/src/services/enrichmentIdentityResolver.ts backend/src/__tests__/fieldConfidenceRegistry.test.ts backend/src/__tests__/enrichmentWaterfall.v3.test.ts backend/src/__tests__/enrichmentIdentityResolver.test.ts
git commit -m "feat(enrichment): restore per-field confidence labels across v3 enrichment"
```

---

### Task 8 — Release note

Fixes 5 and 6 are user-facing — web-sourced fields now show a critic quality view, and confidence labels are restored across all enriched fields. Add a release note. Fixes 1-4, 7 are internal provenance metadata and need no note. This is its own commit (not bundled with Task 6/7).

**Files:**
- Modify: `backend/src/docs/user-release.ts`

- [ ] **Step 1: Insert the new entry**

`backend/src/docs/user-release.ts` exports `userReleaseNotes: UserReleaseNote[]` (each entry `{ date: string; changes: string[] }`), newest-first. The array opens with:

```typescript
export const userReleaseNotes: UserReleaseNote[] = [
  {
    date: '2026-05-21',
    changes: [
      'Fixed: Meta Ads Budget Updates Now Apply the Correct Dollar Amount',
```

Insert this object as the **first** element of the array — immediately after the `[` that opens `userReleaseNotes`, before the existing `2026-05-21` Meta Ads entry:

```typescript
  {
    date: '2026-05-22',
    changes: [
      'Improved: CRM Enrichment Now Shows Source Quality for Every Field',
      '- Web-sourced enriched fields now display a critic quality view (high, low, or drop) so you can see at a glance which web-found values the system considers well-supported',
      '- A "drop" view means the critic could not verify the value against its source — the value is kept and never deleted automatically, but is flagged for your review',
      '- Confidence labels (high / medium / low) are now shown for every enriched field, including Apollo, LinkedIn, web, and pattern-matched results — previously some fields had no confidence label at all',
    ],
  },
```

Also update the `// Last updated:` comment at the top of the file from `// Last updated: 2026-05-21` to `// Last updated: 2026-05-22`.

- [ ] **Step 2: Verify compilation**

Run: `npx tsc`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/docs/user-release.ts
git commit -m "docs: add 2026-05-22 release note for v3 enrichment source attribution"
```

---

# PR C — Customer Portal: Critic-View Badge (separate repo)

PR C is Fix 8 — making the `criticView` signal visible to the user. It lives in the `customer-portal` repo on a matching branch. Frontend UI change → no TDD; follows the portal's existing `npm test` strategy. Before PR B lands, `criticView` is simply `undefined` and the badge renders nothing — forward-safe.

---

### Task 9 — Fix 8: Customer-portal critic-view badge

**Files:**
- New branch: `harshit/v3-enrichment-source-attribution-fixes` in the `customer-portal` repo
- Modify: `customer-portal/src/lib/enrichedFieldValue.ts` (mirror `criticView?`)
- Modify: `customer-portal/src/components/crm/EnrichedValue.tsx` (render the badge)
- Test: `customer-portal/src/__tests__/components/crm/EnrichedValue.test.tsx`

- [ ] **Step 1: Create the matching branch**

All commands in this task run from `customer-portal/` (a separate git repo).

```bash
git -C customer-portal fetch origin main
git -C customer-portal checkout -b harshit/v3-enrichment-source-attribution-fixes origin/main
```

- [ ] **Step 2: Mirror `criticView` in the portal's `EnrichedFieldMeta`**

In `customer-portal/src/lib/enrichedFieldValue.ts`, the interface currently reads (lines 7-25):

```typescript
export interface EnrichedFieldMeta {
  source: 'web_search' | 'linkedin' | 'existing_data' | 'manual' | 'agentweb';
  /**
   * Specific data provider that produced this value (e.g. 'enrich.so',
   * 'unipile', 'crunchbase'). Display badge prefers this label over the
   * generic source category when set. Visible only to admins / delegated.
   */
  provider?: string;
  sourceUrl?: string;
  sourceQuote?: string;
  confidence?: 'high' | 'medium' | 'low';
  enrichedAt: string;
  enrichedJobId?: string;
  verifiedBy?: { userId: string; at: string };
  rejectedReason?: string;
  rejectedAt?: string;
  criticVerdict?: 'supported' | 'partially-supported' | 'unsupported' | 'contradicted';
  normalized?: string | number | { min: number; max: number } | null;
}
```

Replace the `criticVerdict` line with the two lines (`criticVerdict` + new `criticView`):

```typescript
  criticVerdict?: 'supported' | 'partially-supported' | 'unsupported' | 'contradicted';
  /**
   * Advisory per-field quality view derived from the backend critic verdict
   * for web-sourced fields. 'high' = verified, 'low' = questionable,
   * 'drop' = critic recommends removal. The value is never hidden or deleted.
   */
  criticView?: 'drop' | 'low' | 'high';
  normalized?: string | number | { min: number; max: number } | null;
```

- [ ] **Step 3: Verify portal compilation after the type change**

Run: `npx tsc`
Expected: no errors.

- [ ] **Step 4: Render the critic-view badge in `EnrichedValue.tsx`**

In `customer-portal/src/components/crm/EnrichedValue.tsx`, the hover-card currently renders a critic-verdict warning block (lines 200-205):

```tsx
          {meta.criticVerdict && meta.criticVerdict !== 'supported' && (
            <div className="mb-2 inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">
              <AlertTriangle className="h-3 w-3" />
              <span>Critic: {meta.criticVerdict}</span>
            </div>
          )}
```

Replace that block with (add a `criticView` badge above the existing verdict line; the badge color/label match the verdict severity, consistent with the existing `confidenceColors` / `freshnessColors` palette in this file):

```tsx
          {meta.criticView && (
            <div
              className={cn(
                'mb-2 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium',
                meta.criticView === 'high'
                  ? 'bg-emerald-50 text-emerald-700'
                  : meta.criticView === 'low'
                    ? 'bg-amber-50 text-amber-700'
                    : 'bg-rose-50 text-rose-700',
              )}
              title="Critic quality view for this web-sourced field"
            >
              {meta.criticView === 'high'
                ? <CheckCircle2 className="h-3 w-3" />
                : <AlertTriangle className="h-3 w-3" />}
              <span>
                {meta.criticView === 'high'
                  ? 'Critic: verified'
                  : meta.criticView === 'low'
                    ? 'Critic: questionable'
                    : 'Critic: recommends removal'}
              </span>
            </div>
          )}

          {meta.criticVerdict && meta.criticVerdict !== 'supported' && (
            <div className="mb-2 inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">
              <AlertTriangle className="h-3 w-3" />
              <span>Critic: {meta.criticVerdict}</span>
            </div>
          )}
```

(`CheckCircle2` and `AlertTriangle` are already imported at the top of the file — line 13. `cn` is already imported — line 14. No new imports needed.)

- [ ] **Step 5: Verify portal compilation**

Run: `npx tsc`
Expected: no errors.

- [ ] **Step 6: Add badge tests**

In `customer-portal/src/__tests__/components/crm/EnrichedValue.test.tsx`, add a new `describe` block at the end of the top-level `describe('EnrichedValue', ...)` block — immediately before its final closing `});`:

```typescript
  // ─── Critic-view badge (Fix 8) ────────────────────────────────────────────

  describe('critic-view badge', () => {
    it('renders "Critic: verified" when criticView is high', async () => {
      const meta: EnrichedFieldMeta = { ...freshMeta, criticView: 'high' };
      const { container } = render(<EnrichedValue value="Series B" meta={meta} />);
      fireEvent.mouseEnter(container.firstChild as Element);
      await waitFor(() => expect(screen.getByText(/Critic: verified/)).toBeTruthy());
    });

    it('renders "Critic: questionable" when criticView is low', async () => {
      const meta: EnrichedFieldMeta = { ...freshMeta, criticView: 'low' };
      const { container } = render(<EnrichedValue value="Series B" meta={meta} />);
      fireEvent.mouseEnter(container.firstChild as Element);
      await waitFor(() => expect(screen.getByText(/Critic: questionable/)).toBeTruthy());
    });

    it('renders "Critic: recommends removal" when criticView is drop', async () => {
      const meta: EnrichedFieldMeta = { ...freshMeta, criticView: 'drop' };
      const { container } = render(<EnrichedValue value="Series B" meta={meta} />);
      fireEvent.mouseEnter(container.firstChild as Element);
      await waitFor(() => expect(screen.getByText(/Critic: recommends removal/)).toBeTruthy());
    });

    it('renders nothing critic-view related when criticView is absent', async () => {
      const { container } = render(<EnrichedValue value="Series B" meta={freshMeta} />);
      fireEvent.mouseEnter(container.firstChild as Element);
      await waitFor(() => expect(screen.getByText(/Series B SaaS startup/)).toBeTruthy());
      expect(screen.queryByText(/Critic: verified/)).toBeNull();
      expect(screen.queryByText(/Critic: questionable/)).toBeNull();
      expect(screen.queryByText(/Critic: recommends removal/)).toBeNull();
    });
  });
```

- [ ] **Step 7: Run the portal tests**

Run: `npx vitest run EnrichedValue`
Expected: PASS — all existing `EnrichedValue` tests plus the four new badge tests.

(If `vitest` is not the configured runner, run `npm test -- EnrichedValue` instead — check `customer-portal/package.json` `scripts.test`.)

- [ ] **Step 8: Commit**

```bash
git -C customer-portal add src/lib/enrichedFieldValue.ts src/components/crm/EnrichedValue.tsx src/__tests__/components/crm/EnrichedValue.test.tsx
git -C customer-portal commit -m "feat(crm): show critic quality view badge on enriched fields"
```

---

## Final Verification

### Backend (PR A + PR B)

- [ ] **Full type check:** from `backend/`, run `npx tsc` — expected: no errors.
- [ ] **Full test suite:** from `backend/`, run `npm test` — expected: all tests pass.
- [ ] **Coverage gate:** CI requires ≥95% on statements/branches/functions/lines. Run `npm run test:coverage -- --coverageReporters=text --coverageReporters=json-summary` and confirm the new branches in Tasks 2, 3, 5, 6, 7 (smart-field `provider`, pattern-email meta, `LLMFilledValue` normalization, `criticView` derivation, `metaApollo` downgrade, `makeApiMeta` per-field) are covered.
- [ ] **Commit history:** 8 focused backend commits (Tasks 1-8), one per task, none with a `Co-Authored-By` / AI-identity trailer — Tasks 1-5 on `harshit/v3-enrichment-source-attribution-fixes` (PR A), Tasks 6-8 on `harshit/v3-enrichment-critic-view` (PR B). Verify each with `git log --oneline`.
- [ ] Open **PR A** with `gh pr create` from `harshit/v3-enrichment-source-attribution-fixes` → base `main`.
- [ ] Open **PR B** with `gh pr create` from `harshit/v3-enrichment-critic-view` → base `harshit/v3-enrichment-source-attribution-fixes` (retarget to `main` after PR A merges). Do not use `--delete-branch` on merge.

### Customer portal (PR C)

- [ ] **Type check:** from `customer-portal/`, run `npx tsc` — expected: no errors.
- [ ] **Tests:** from `customer-portal/`, run `npm test` — expected: all tests pass.
- [ ] **Commit history:** `git -C customer-portal log --oneline origin/main..HEAD` — expected: 1 commit (Task 9), no AI-identity trailer.
- [ ] Push the branch and open the customer-portal PR with `gh pr create` from inside `customer-portal/`.

---

## Self-Review Checklist (completed during planning)

- **Spec coverage:** all 8 fixes map to tasks — Fix 4→Task 1, Fix 3→Task 2, Fix 2→Task 3, Fix 7→Task 4, Fix 1→Task 5 (PR A); Fix 5→Task 6, Fix 6→Task 7, release note→Task 8 (PR B); Fix 8→Task 9 (PR C).
- **Placeholders:** none — every code block contains the real current code (verified against the source files) and the exact replacement.
- **Type consistency:** `LLMFilledValue` (defined once in `enrichmentGroupWaterfall.ts`, imported by `enrichmentV3RealDeps.ts`), `LLMExtractResult.filled: Record<string,LLMFilledValue>`, `metaApollo(field, opts?)`, `metaWeb(sourceUrl?, sourceQuote?)`, `metaUnipile()`, `makeApiMeta(provider, field?)`, and `criticView?: 'drop'|'low'|'high'` are used identically across every task that references them.
- **`metaWeb` single-edit:** `metaWeb` gains `provider`/`url`/`quote`/`confidence` once, in Task 5 Step 4. Task 7 explicitly leaves it untouched.
- **`metaApollo` argument migration:** Task 5 deliberately keeps `metaApollo()` (no arg) at the Tier 3 and Tier 3.5c sites so PR A compiles; Task 7 changes the signature and updates all three call sites in one pass — no call site is left with a wrong arity.
- **Existing-test breakage:** Fix 1's contract change breaks 15 `extractFieldsViaLLM` mocks in `enrichmentWaterfall.v3.test.ts`; Task 5 Step 2 migrates every one with the `fv()` helper. `npx tsc` after Step 9 catches any miss.
- **`npx tsc` after every `.ts` edit:** every task includes explicit `npx tsc` steps; Task 5 and Task 7 add intermediate `npx tsc` checkpoints because their edits span two files and would otherwise leave a transient compile error.
- **Cross-repo:** `'existing_data'` enum stays (Fix 4 removes only the dead filter). Customer-portal is a separate repo — Task 9 creates its branch and uses `git -C customer-portal`.
- **Commit granularity:** one commit per fix (test + implementation together); release note is its own commit; no `Co-Authored-By` trailer anywhere.
