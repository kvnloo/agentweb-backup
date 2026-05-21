# CRM Enrichment v3 — Review-Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two verified correctness bugs and the high-value quick wins from the 7-agent code review of the CRM enrichment v3 subsystem, on branch `harshit/crm-enrichment-v3-review-fixes`.

**Architecture:** Pure, mechanical fixes to four backend service files. No new modules, no API surface change. Each task is behaviour-preserving except Task 6 (paginates a query) and Task 7 (parallelises independent writes). The public `RunEnrichmentResult` shape is deliberately kept stable so the customer-portal UI is unaffected.

**Tech Stack:** Node.js / TypeScript, Express, DynamoDB, Jest. Backend only — no customer-portal changes.

---

## Background

This plan implements the verified findings from a multi-agent review of:

- `backend/src/services/crmEnrichmentServiceV3.ts` (orchestrator)
- `backend/src/services/enrichmentV3RealDeps.ts` (real dependency wiring)
- `backend/src/services/enrichmentWaterfall.ts` (waterfall)
- `backend/src/services/enrichmentGroupWaterfall.ts` (group waterfall — not modified by this plan)

### In scope (this branch)

| Task | Finding | Type | File(s) |
|------|---------|------|---------|
| 1 | V-RU4 — `STANDARD_LEAD_COLUMNS` defined 3× | refactor | configService, V3, realDeps |
| 2 | V-EN5 — `emailStatus→confidence` ternary ×3 | refactor | waterfall |
| 3 | V-EN9 — stale "Phase 1a stubbed" header comment | comment | realDeps |
| 4 | V-EN1 — dead `searchWeb` failure category | dead-code removal | V3 |
| 5 | V-PF6 — `buildSiblingFieldMappingTable` runs with 0 leads | bug | V3 |
| 6 | V-PF5 — `loadLeads` truncates large lists to one DDB page | **correctness bug** | realDeps |
| 7 | V-PF1 — per-chunk lead writes are serialised | perf | V3 |
| 8 | V-RU1 — Apollo async-poll loop duplicated verbatim | refactor | waterfall, realDeps |
| 9 | Release note for the user-facing fix (Task 6) | docs | user-release.ts |

### Deferred (NOT this branch — separate follow-up)

- **V-PF2** — the Tier-3 Apollo broker poll blocks a concurrency slot for up to 90s. Architectural change; pairs with a rework of the chunked lead loop.
- **V-EN1 (full version)** — genuinely propagating *hard* web-search failures into `searchWebFailed`. Requires a new signal threaded through `GroupResult` → the waterfall → the orchestrator. Task 4 below only removes the dead/unreachable code; it does not wire up real web-failure counting.
- **V-PF3** — caching ungrouped web fetches.
- Low-priority cleanups: V-RU2 (domain extractors), V-RU5 (`templateHasNoLeadSignal`), V-RU6 (`leadValueIsEmpty`/`getLeadFieldValue`), V-EN7 (`processLead` extraction), `lead: any` typing, etc.

### ⚠️ Scope note on Task 4 (V-EN1)

The review proposed *either* removing the `searchWeb` category *or* wiring it up. Investigation found `searchWebFailed` is consumed cross-repo: `customer-portal/src/components/crm/EnrichmentConfigDialog.tsx` and `EnrichmentHistoryDialog.tsx` read `failed.searchWebFailed`, and the v2 service (`crmEnrichmentService.ts`) genuinely populates it. Therefore:

- **Removing the result field is out** — it would break the customer-portal.
- **This plan removes only the genuinely dead code** — the `'searchWeb'` member of the `LeadFailureCategory` union and the unreachable `case 'searchWeb'`. The result field `failed.searchWebFailed` stays, hardcoded to `0`, with a comment explaining v3 treats web-fetch failures as soft degradations. Properly counting hard web failures is the deferred V-EN1 work above.

---

## File Structure

**Modified (source):**
- `backend/src/services/enrichmentConfigService.ts` — export `STANDARD_ENRICHABLE_FIELDS` (Task 1)
- `backend/src/services/crmEnrichmentServiceV3.ts` — Tasks 1, 4, 5, 7
- `backend/src/services/enrichmentV3RealDeps.ts` — Tasks 1, 3, 6, 8
- `backend/src/services/enrichmentWaterfall.ts` — Tasks 2, 8
- `backend/src/docs/user-release.ts` — Task 9

**Created (tests):**
- `backend/src/__tests__/enrichmentV3RealDepsLoadLeads.test.ts` — Task 6
- `backend/src/__tests__/enrichmentV3RealDepsApolloBroker.test.ts` — Task 8

**Modified (tests):**
- `backend/src/__tests__/crmEnrichmentServiceV3.test.ts` — Tasks 5, 7
- `backend/src/__tests__/enrichmentConfigService.test.ts` — Task 1

---

## Shared Conventions

- All commands run from `backend/`.
- **After every edit to any `.ts` file (including test files), run `npx tsc`** before moving on (project rule).
- Run a focused test file with `npx jest <pattern>` (e.g. `npx jest crmEnrichmentServiceV3`).
- Each task = one commit (test + implementation together — each task is one atomic logical change). Task 9 (release notes) is its own commit.
- **Commit messages must NOT include a `Co-Authored-By: Claude` trailer** (user preference).
- Branch is already created: `harshit/crm-enrichment-v3-review-fixes`.

---

### Task 1: Deduplicate `STANDARD_LEAD_COLUMNS` (V-RU4)

The 8-name standard-column set is declared three times: `enrichmentConfigService.ts:127` (`STANDARD_ENRICHABLE_FIELDS`), `crmEnrichmentServiceV3.ts:217` (`STANDARD_LEAD_COLUMNS`), and inline in `enrichmentV3RealDeps.ts:284`. Export the canonical one and derive the other two from it.

**Files:**
- Modify: `backend/src/services/enrichmentConfigService.ts:127`
- Modify: `backend/src/services/crmEnrichmentServiceV3.ts:217-219` (+ import)
- Modify: `backend/src/services/enrichmentV3RealDeps.ts:284` (+ import)
- Test: `backend/src/__tests__/enrichmentConfigService.test.ts`

- [ ] **Step 1: Write the lock-in test**

Add to `backend/src/__tests__/enrichmentConfigService.test.ts` (inside the top-level `describe`, or as a new `describe`):

```typescript
import { STANDARD_ENRICHABLE_FIELDS } from '../services/enrichmentConfigService';

describe('STANDARD_ENRICHABLE_FIELDS export', () => {
  it('exports the 8 canonical standard lead columns', () => {
    expect([...STANDARD_ENRICHABLE_FIELDS]).toEqual([
      'firstName', 'lastName', 'email', 'company', 'phone', 'title', 'linkedin', 'notes',
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest enrichmentConfigService`
Expected: FAIL — `STANDARD_ENRICHABLE_FIELDS` is not exported (`has no exported member 'STANDARD_ENRICHABLE_FIELDS'`).

- [ ] **Step 3: Export the constant**

In `backend/src/services/enrichmentConfigService.ts`, change line 127 from:

```typescript
const STANDARD_ENRICHABLE_FIELDS = [
```

to:

```typescript
export const STANDARD_ENRICHABLE_FIELDS = [
```

- [ ] **Step 4: Use it in `crmEnrichmentServiceV3.ts`**

Add this import alongside the existing imports near the top of `backend/src/services/crmEnrichmentServiceV3.ts` (after the `mergeCustomFields` import on line 28):

```typescript
import { STANDARD_ENRICHABLE_FIELDS } from './enrichmentConfigService';
```

Replace lines 214-219:

```typescript
/** Standard CRM lead columns — values for these field names go to top-level
 *  AW-Leads attributes via setLeadFields.topLevel (not customFields). Mirrors
 *  STANDARD_ENRICHABLE_FIELDS in enrichmentConfigService. */
const STANDARD_LEAD_COLUMNS = new Set<string>([
  'firstName', 'lastName', 'email', 'company', 'phone', 'title', 'linkedin', 'notes',
]);
```

with:

```typescript
/** Standard CRM lead columns — values for these field names go to top-level
 *  AW-Leads attributes via setLeadFields.topLevel (not customFields). */
const STANDARD_LEAD_COLUMNS = new Set<string>(STANDARD_ENRICHABLE_FIELDS);
```

- [ ] **Step 5: Use it in `enrichmentV3RealDeps.ts`**

Add to the import block of `backend/src/services/enrichmentV3RealDeps.ts` (after line 24, `import { FIELD_GROUPS } from './enrichmentGroups';`):

```typescript
import { STANDARD_ENRICHABLE_FIELDS } from './enrichmentConfigService';
```

Replace line 284:

```typescript
      const STANDARD = new Set(['firstName', 'lastName', 'email', 'company', 'phone', 'title', 'linkedin', 'notes']);
```

with:

```typescript
      const STANDARD = new Set<string>(STANDARD_ENRICHABLE_FIELDS);
```

- [ ] **Step 6: Verify compilation and tests**

Run: `npx tsc`
Expected: no errors. (`enrichmentConfigService.ts` only imports `FIELD_GROUPS` — no import cycle is introduced.)

Run: `npx jest enrichmentConfigService crmEnrichmentServiceV3 enrichmentV3RealDeps`
Expected: PASS (including the new lock-in test).

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/enrichmentConfigService.ts backend/src/services/crmEnrichmentServiceV3.ts backend/src/services/enrichmentV3RealDeps.ts backend/src/__tests__/enrichmentConfigService.test.ts
git commit -m "refactor(enrichment): single source for STANDARD_ENRICHABLE_FIELDS in v3"
```

---

### Task 2: Deduplicate the `emailStatus → confidence` ternary (V-EN5)

`enrichmentWaterfall.ts` hand-rolls `verified→high / guessed→low / else→medium` three times. `apolloEmailStatusToConfidence` in `apolloFieldMapper.ts:262` does exactly this (it lowercases internally).

**Files:**
- Modify: `backend/src/services/enrichmentWaterfall.ts:22` (import), `:533-537`, `:573-577`, `:632-636`

- [ ] **Step 1: Add the import**

In `backend/src/services/enrichmentWaterfall.ts`, change line 22 from:

```typescript
import type { MappedPerson, MappedMatch } from './apolloFieldMapper';
```

to:

```typescript
import { apolloEmailStatusToConfidence, type MappedPerson, type MappedMatch } from './apolloFieldMapper';
```

- [ ] **Step 2: Replace the two `f.emailStatus` ternaries (lines 533-537 and 573-577)**

Both blocks are identical text. Replace each occurrence of:

```typescript
            const status = (f.emailStatus ?? '').toLowerCase();
            const confidence: EnrichSoConfidence =
              status === 'verified' ? 'high' :
              status === 'guessed' ? 'low' :
              'medium';
```

with:

```typescript
            const confidence: EnrichSoConfidence = apolloEmailStatusToConfidence(f.emailStatus ?? '');
```

- [ ] **Step 3: Replace the `polled.emailStatus` ternary (lines 632-636)**

Replace:

```typescript
          const status = (polled.emailStatus ?? '').toLowerCase();
          const confidence: EnrichSoConfidence =
            status === 'verified' ? 'high' :
            status === 'guessed' ? 'low' :
            'medium';
```

with:

```typescript
          const confidence: EnrichSoConfidence = apolloEmailStatusToConfidence(polled.emailStatus ?? '');
```

- [ ] **Step 4: Verify compilation**

Run: `npx tsc`
Expected: no errors. (`apolloEmailStatusToConfidence` returns `'high' | 'medium' | 'low'`, which is exactly `EnrichSoConfidence` — `enrichSoService.ts:21`.)

- [ ] **Step 5: Verify tests (behaviour-preserving refactor)**

Run: `npx jest enrichmentWaterfall`
Expected: PASS — `apolloEmailStatusToConfidence` is logically identical to the removed ternary, so existing waterfall tests cover this.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/enrichmentWaterfall.ts
git commit -m "refactor(enrichment): use apolloEmailStatusToConfidence in waterfall"
```

---

### Task 3: Fix the stale "Phase 1a stubbed" header comment (V-EN9)

`enrichmentV3RealDeps.ts:1-12` claims web fetch / LLM extraction / critic are "stubbed" — but `fetchWebForGroupReal`, `extractFieldsViaLLMReal`, and `runCriticReal` are all fully implemented in the same file. The comment actively misinforms. This is a comment-only change (no test; TDD does not apply).

**Files:**
- Modify: `backend/src/services/enrichmentV3RealDeps.ts:1-12`

- [ ] **Step 1: Replace the header comment**

Replace lines 1-12:

```typescript
// Real-service adapters that satisfy v3.1 orchestrator deps.
//
// Phase 1a status (matches what users see today):
//   ✓ Apollo people + org enrichment via existing apolloService
//   ✓ enrich.so reverse lookup via existing enrichSoService
//   ✓ DDB read/write via crmDb
//   ✗ Web fetch + LLM extraction + critic — stubbed (return empty / null)
//     until Phase 1b wires the existing v2 extraction pipeline.
//
// Apollo direct-map fields WILL populate on a real run. Web-only groups
// (intent_signals, company_social) will show 'missing' fields in the report,
// which is expected behavior pre-Phase-1b.
```

with:

```typescript
// Real-service adapters that satisfy the v3.1 orchestrator deps
// (OrchestratorDeps + IdentityResolverDeps).
//
// Wires the orchestrator and waterfall to production services: Apollo
// (people / org), enrich.so, Unipile, Google CSE web search + LLM extraction,
// the critic pass, and DynamoDB read/write via crmDb. All external dependency
// construction lives here so the orchestrator and waterfall stay pure and
// unit-testable.
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/enrichmentV3RealDeps.ts
git commit -m "docs(enrichment): correct stale 'stubbed' header in enrichmentV3RealDeps"
```

---

### Task 4: Remove the dead `searchWeb` failure category (V-EN1)

`LeadFailureCategory` includes `'searchWeb'` and `runEnrichment` has a `case 'searchWeb'`, but no code path ever returns `failureCategory: 'searchWeb'` — it is unreachable dead code. Remove the union member, the unreachable case, and the always-zero local variable. Keep `failed.searchWebFailed` in the result (hardcoded `0`) for result-shape parity with the v2 path and the customer-portal UI — see the Scope note above. This change is 100% behaviour-preserving (the removed code never executed), so it is verified by `npx tsc` + the existing suite rather than a new red test.

**Files:**
- Modify: `backend/src/services/crmEnrichmentServiceV3.ts:340`, `:817`, `:886-888`, `:921`, `:947`, `:958`

- [ ] **Step 1: Remove `'searchWeb'` from the `LeadFailureCategory` union**

Replace lines 337-341:

```typescript
type LeadFailureCategory =
  | 'identityResolution'
  | 'llmOrParse'
  | 'searchWeb'
  | 'update';
```

with:

```typescript
type LeadFailureCategory =
  | 'identityResolution'
  | 'llmOrParse'
  | 'update';
```

- [ ] **Step 2: Remove the always-zero local variable**

Delete line 817:

```typescript
  let searchWebFailed = 0;
```

- [ ] **Step 3: Remove the unreachable switch case**

Delete lines 886-888:

```typescript
        case 'searchWeb':
          searchWebFailed += 1;
          continue;
```

- [ ] **Step 4: Drop `searchWebFailed` from the in-loop `failedSoFar` sum**

Replace lines 920-921:

```typescript
    const failedSoFar =
      identityResolutionFailed + llmOrParseFailed + searchWebFailed + updateFailed;
```

with:

```typescript
    const failedSoFar =
      identityResolutionFailed + llmOrParseFailed + updateFailed;
```

- [ ] **Step 5: Replace the result field with a documented literal**

In the `result.failed` object (lines 942-948), replace the shorthand `searchWebFailed,` with an explicit literal. The block becomes:

```typescript
    failed: {
      identityResolutionFailed,
      apolloFailed,
      llmOrParseFailed,
      updateFailed,
      // v3 treats web-fetch failures as soft degradations — affected fields
      // fall through to 'missing' rather than failing the lead — so there is
      // no hard web-failure count. Kept at 0 for result-shape parity with the
      // v2 path and the customer-portal failure-breakdown UI.
      searchWebFailed: 0,
    },
```

- [ ] **Step 6: Drop `searchWebFailed` from the final `totalFailed` sum**

Replace lines 957-958:

```typescript
  const totalFailed =
    identityResolutionFailed + llmOrParseFailed + searchWebFailed + updateFailed;
```

with:

```typescript
  const totalFailed =
    identityResolutionFailed + llmOrParseFailed + updateFailed;
```

- [ ] **Step 7: Verify compilation and tests**

Run: `npx tsc`
Expected: no errors. The `RunEnrichmentResult.failed` interface (line 125, `searchWebFailed: number;`) is unchanged and is satisfied by the `searchWebFailed: 0` literal. The `switch` remains exhaustive over `'identityResolution' | 'llmOrParse' | 'update' | null`.

Run: `npx jest crmEnrichmentServiceV3`
Expected: PASS — no v3 test references `searchWebFailed`; existing tests check individual `failed.*` counters only.

- [ ] **Step 8: Commit**

```bash
git add backend/src/services/crmEnrichmentServiceV3.ts
git commit -m "refactor(enrichment): remove dead searchWeb failure category from v3"
```

---

### Task 5: Skip `buildSiblingFieldMappingTable` when there are no leads (V-PF6)

`buildSiblingFieldMappingTable` makes an LLM call. It runs unconditionally at `crmEnrichmentServiceV3.ts:799`, even when `loadLeads` returned zero leads (empty list, or a `leadIds` filter that matched nothing) — a paid LLM round-trip whose result no `processLead` consumes.

**Files:**
- Modify: `backend/src/services/crmEnrichmentServiceV3.ts:799`
- Test: `backend/src/__tests__/crmEnrichmentServiceV3.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `backend/src/__tests__/crmEnrichmentServiceV3.test.ts` (a new `describe` block near the existing "empty list" describe):

```typescript
describe('runEnrichment — empty list skips sibling mapping table', () => {
  it('does not call buildSiblingFieldMappingTable when there are no leads', async () => {
    const { buildSiblingFieldMappingTable } = require('../services/enrichmentSiblingConfigFields');
    (buildSiblingFieldMappingTable as jest.Mock).mockClear();

    const deps = makeDeps({ loadLeads: jest.fn().mockResolvedValue([]) });
    await runEnrichment(makeInput(), deps);

    expect(buildSiblingFieldMappingTable as jest.Mock).not.toHaveBeenCalled();
  });
});
```

(`buildSiblingFieldMappingTable` is already module-mocked at the top of this test file — lines 17-20.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest crmEnrichmentServiceV3 -t "skips sibling mapping table"`
Expected: FAIL — `buildSiblingFieldMappingTable` is currently called unconditionally (`expect(...).not.toHaveBeenCalled()` fails).

- [ ] **Step 3: Add the guard**

In `backend/src/services/crmEnrichmentServiceV3.ts`, replace lines 797-799:

```typescript
  // Build sibling field mapping table once per run (one LLM call for unaliased
  // fields, canonical match is free). Passed to every processLead call.
  const siblingMappingTable = await buildSiblingFieldMappingTable(workingConfig.fields);
```

with:

```typescript
  // Build sibling field mapping table once per run (one LLM call for unaliased
  // fields, canonical match is free). Passed to every processLead call. Skipped
  // entirely when there are no leads — no processLead would consume it.
  const siblingMappingTable: SiblingFieldMappingTable = leads.length > 0
    ? await buildSiblingFieldMappingTable(workingConfig.fields)
    : { canonical: new Map(), llm: new Map() };
```

(`SiblingFieldMappingTable` is already imported on line 26.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest crmEnrichmentServiceV3 -t "skips sibling mapping table"`
Expected: PASS.

- [ ] **Step 5: Verify compilation and the full file's tests**

Run: `npx tsc`
Expected: no errors. (The empty-table shape `{ canonical: new Map(), llm: new Map() }` matches the test mock's shape and the `SiblingFieldMappingTable` type.)

Run: `npx jest crmEnrichmentServiceV3`
Expected: PASS (all existing tests + the new one).

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/crmEnrichmentServiceV3.ts backend/src/__tests__/crmEnrichmentServiceV3.test.ts
git commit -m "fix(enrichment): skip sibling-mapping LLM call when v3 run has no leads"
```

---

### Task 6: Paginate `loadLeads` whole-list query (V-PF5) — correctness bug

`loadLeads`' whole-list path calls `crmDb.getLeadsByListId(listId)` once. A DynamoDB `Query` returns at most one ~1MB page; `getLeadsByListId` exposes `lastEvaluatedKey`/`hasMore` but `loadLeads` ignores them. Lists larger than ~1MB of lead items are **silently truncated** — leads past the first page are never enriched, with no error. Loop until the key is exhausted.

**Files:**
- Modify: `backend/src/services/enrichmentV3RealDeps.ts:674-678`
- Test: `backend/src/__tests__/enrichmentV3RealDepsLoadLeads.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/enrichmentV3RealDepsLoadLeads.test.ts`:

```typescript
// Tests for buildOrchestratorDeps().loadLeads — whole-list pagination.
import { buildOrchestratorDeps } from '../services/enrichmentV3RealDeps';
import { crmDb } from '../services/db';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('buildOrchestratorDeps().loadLeads — whole-list pagination', () => {
  it('follows lastEvaluatedKey across pages and returns every lead', async () => {
    const page1 = {
      items: [{ leadId: 'l1' }, { leadId: 'l2' }],
      lastEvaluatedKey: { listId: 'list-1', leadId: 'l2' },
      hasMore: true,
    };
    const page2 = {
      items: [{ leadId: 'l3' }],
      lastEvaluatedKey: null,
      hasMore: false,
    };
    const spy = jest.spyOn(crmDb, 'getLeadsByListId')
      .mockResolvedValueOnce(page1 as any)
      .mockResolvedValueOnce(page2 as any);

    const deps = buildOrchestratorDeps('user-1');
    const leads = await deps.loadLeads({ listId: 'list-1', userId: 'user-1' });

    expect(leads.map((l: any) => l.leadId)).toEqual(['l1', 'l2', 'l3']);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(2, 'list-1', undefined, { listId: 'list-1', leadId: 'l2' });
  });

  it('returns a single page when there is no lastEvaluatedKey', async () => {
    jest.spyOn(crmDb, 'getLeadsByListId').mockResolvedValue({
      items: [{ leadId: 'l1' }],
      lastEvaluatedKey: null,
      hasMore: false,
    } as any);

    const deps = buildOrchestratorDeps('user-1');
    const leads = await deps.loadLeads({ listId: 'list-1', userId: 'user-1' });

    expect(leads.map((l: any) => l.leadId)).toEqual(['l1']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest enrichmentV3RealDepsLoadLeads`
Expected: FAIL on the first test — the current code calls `getLeadsByListId` once and returns only `['l1', 'l2']`.

- [ ] **Step 3: Implement pagination**

In `backend/src/services/enrichmentV3RealDeps.ts`, replace lines 674-678:

```typescript
      // Whole-list run → single Query page. No explicit limit: DDB returns
      // up to ~1MB worth of items in one round-trip.
      const result = await crmDb.getLeadsByListId(listId);
      return (result?.items ?? []) as LeadRecord[];
```

with:

```typescript
      // Whole-list run → page through the Query fully. A single
      // getLeadsByListId call returns at most one ~1MB DDB page; without this
      // loop, lists larger than that page are silently truncated and the
      // remaining leads are never enriched.
      const all: LeadRecord[] = [];
      let startKey: any = undefined;
      do {
        const page = await crmDb.getLeadsByListId(listId, undefined, startKey);
        all.push(...((page?.items ?? []) as LeadRecord[]));
        startKey = page?.lastEvaluatedKey ?? null;
      } while (startKey);
      return all;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest enrichmentV3RealDepsLoadLeads`
Expected: PASS (both tests).

- [ ] **Step 5: Verify compilation and related tests**

Run: `npx tsc`
Expected: no errors.

Run: `npx jest enrichmentV3RealDeps`
Expected: PASS (the new file plus existing `enrichmentV3RealDeps*` tests).

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/enrichmentV3RealDeps.ts backend/src/__tests__/enrichmentV3RealDepsLoadLeads.test.ts
git commit -m "fix(enrichment): paginate v3 loadLeads so large lists are not truncated"
```

---

### Task 7: Parallelise per-chunk lead writes (V-PF1)

`runEnrichment` processes 20 leads per chunk in parallel, then consumes the outcomes in a `for` loop that does `await writeLeadOutcome(...)` one lead at a time. Each `setLeadFields` is 2-4 DynamoDB round-trips, all serialised. The writes are independent per `leadId` — issue them concurrently.

> **Depends on Task 4** — the code below assumes the `case 'searchWeb'` has already been removed from the switch.

**Files:**
- Modify: `backend/src/services/crmEnrichmentServiceV3.ts:866-917` (the per-chunk outcomes loop)
- Test: `backend/src/__tests__/crmEnrichmentServiceV3.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `backend/src/__tests__/crmEnrichmentServiceV3.test.ts` (new `describe` block):

```typescript
describe('runEnrichment — concurrent chunk writes', () => {
  it('writes all leads in a chunk concurrently, not one-at-a-time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const setLeadFields = jest.fn().mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 10));
      inFlight -= 1;
    });
    const deps = makeDeps({
      loadLeads: jest.fn().mockResolvedValue([
        makeLead({ leadId: 'l1' }),
        makeLead({ leadId: 'l2' }),
        makeLead({ leadId: 'l3' }),
      ]),
      runWaterfall: jest.fn().mockResolvedValue({
        fields: [{
          field: 'company_name',
          value: 'Acme',
          meta: { source: 'apollo', enrichedAt: '2026-01-01T00:00:00Z' },
        }],
        missing: [],
        tierFills: { crm: 0, apollo: 1, web: 0, missing: 0 },
      }),
      setLeadFields,
    });

    const result = await runEnrichment(makeInput(), deps);

    expect(result.processed).toBe(3);
    expect(setLeadFields).toHaveBeenCalledTimes(3);
    // Sequential writes would never have more than one call in flight at once.
    expect(maxInFlight).toBe(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest crmEnrichmentServiceV3 -t "concurrent chunk writes"`
Expected: FAIL — current code awaits each write before starting the next, so `maxInFlight` is `1`, not `3`.

- [ ] **Step 3: Split the outcomes loop into a count pass + a concurrent write pass**

In `backend/src/services/crmEnrichmentServiceV3.ts`, replace the entire `for (const { lead, outcome } of outcomes) { ... }` block (lines 867-917, as it stands after Task 4 removed the `searchWeb` case) with:

```typescript
    // Pass 1 — tally counters and collect the leads that need a DB write.
    // Counting is cheap and order-independent; the writes are the expensive
    // part and are issued concurrently in pass 2.
    const pendingWrites: Array<{ lead: LeadRecord; outcome: PerLeadOutcome }> = [];
    for (const { lead, outcome } of outcomes) {
      // Apollo failures are independent of pass/fail — count them regardless of outcome.
      if (outcome.apolloOrgFailed || outcome.apolloPersonFailed) apolloFailed += 1;

      // Aggregate tier counts only on success — failed leads contribute nothing.
      if (outcome.failureCategory === null) {
        for (const [groupName, counts] of outcome.perGroupTierFills.entries()) {
          tierBreakdown[groupName] = addTierCounts(tierBreakdown[groupName] ?? emptyTierCount(), counts);
        }
      }

      switch (outcome.failureCategory) {
        case 'identityResolution':
          identityResolutionFailed += 1;
          continue;
        case 'llmOrParse':
          llmOrParseFailed += 1;
          continue;
        case 'update':
          updateFailed += 1;
          continue;
        case null:
          break;     // success path falls through
      }

      outcome.fills = normalizeFills(outcome.fills, fieldAliasMap);

      if (input.mode === 'preview') {
        const extractedFields: Record<string, string> = {};
        const meta: Record<string, EnrichedFieldMeta> = {};
        for (const f of outcome.fills) {
          extractedFields[f.field] = f.value;
          meta[f.field] = f.meta;
        }
        previewSamples.push({ leadId: lead.leadId, extractedFields, meta });
        processed += 1;
      } else {
        pendingWrites.push({ lead, outcome });
      }
    }

    // Pass 2 — issue all writes for this chunk concurrently. Each write is an
    // independent per-leadId DynamoDB update, so there is no ordering hazard.
    if (pendingWrites.length > 0) {
      const writeResults = await Promise.all(
        pendingWrites.map(async ({ lead, outcome }) => {
          const wStart = Date.now();
          const writeResult = await writeLeadOutcome(lead, outcome, input, deps);
          console.log(`[v3][lead ${lead.leadId}] write in ${Date.now() - wStart}ms (ok=${writeResult.ok})`);
          return writeResult;
        }),
      );
      for (const writeResult of writeResults) {
        if (writeResult.ok) {
          processed += 1;
        } else {
          updateFailed += 1;
        }
      }
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest crmEnrichmentServiceV3 -t "concurrent chunk writes"`
Expected: PASS — all 3 writes are now in flight together, `maxInFlight === 3`.

- [ ] **Step 5: Verify compilation and the full file's tests**

Run: `npx tsc`
Expected: no errors. (`LeadRecord` and `PerLeadOutcome` are both already in scope.)

Run: `npx jest crmEnrichmentServiceV3`
Expected: PASS — counter ordering is preserved; only the write timing changed.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/crmEnrichmentServiceV3.ts backend/src/__tests__/crmEnrichmentServiceV3.test.ts
git commit -m "perf(enrichment): write v3 chunk leads concurrently instead of serially"
```

---

### Task 8: Deduplicate the Apollo async-poll loop (V-RU1)

`enrichmentV3RealDeps.ts:232-258` inlines an Apollo placeholder-row poll loop that is a verbatim copy of `waitForApolloAsyncResult` in `enrichmentWaterfall.ts:68-103` (the copies have already drifted — 30s vs configurable 90s budget). Export the waterfall function and call it from `apolloBrokerChain`.

> **Out of scope for this task:** the placeholder-row *write* (`putEnrichmentCacheItem`) is also duplicated, but extracting it touches the waterfall's `C9`-commented critical section and is coupled with the deferred V-EN4 guard fix. This task deduplicates the **poll loop only**.

**Files:**
- Modify: `backend/src/services/enrichmentWaterfall.ts:68` (export)
- Modify: `backend/src/services/enrichmentV3RealDeps.ts` (import + replace inline loop)
- Test: `backend/src/__tests__/enrichmentV3RealDepsApolloBroker.test.ts` (new)

- [ ] **Step 1: Write the regression-protection test**

Create `backend/src/__tests__/enrichmentV3RealDepsApolloBroker.test.ts`:

```typescript
// Tests for buildIdentityDeps().apolloBrokerChain async polling — verifies the
// shared waitForApolloAsyncResult path returns the webhook result.
import { buildIdentityDeps } from '../services/enrichmentV3RealDeps';
import * as apolloServiceModule from '../services/apolloService';
import { crmDb } from '../services/db';

afterEach(() => {
  jest.restoreAllMocks();
});

function mockApollo(findEmailResult: any) {
  const findEmail = jest.fn().mockResolvedValue(findEmailResult);
  jest.spyOn(apolloServiceModule, 'isApolloServiceReady').mockReturnValue(true);
  jest.spyOn(apolloServiceModule, 'getApolloService').mockReturnValue({ findEmail } as any);
  jest.spyOn(crmDb, 'putEnrichmentCacheItem').mockResolvedValue(undefined as any);
}

describe('apolloBrokerChain — async polling via shared waitForApolloAsyncResult', () => {
  it('returns the email once the placeholder row is marked completed', async () => {
    mockApollo({ found: false, asyncPending: true, asyncRequestId: 'req-123' });
    jest.spyOn(crmDb, 'getEnrichmentCacheItem').mockResolvedValue({
      rawData: { status: 'completed', result: { email: 'jane@acme.com', emailStatus: 'verified' } },
    } as any);

    const deps = buildIdentityDeps('user-1');
    const result = await deps.apolloBrokerChain(
      { firstName: 'Jane', lastName: 'Doe', domain: 'acme.com' },
      { listId: 'list-1', leadId: 'lead-1' },
    );

    expect(result).toEqual({ email: 'jane@acme.com', emailStatus: 'verified' });
    expect(crmDb.getEnrichmentCacheItem).toHaveBeenCalled();
  });

  it('returns null when the placeholder row resolves to no_email', async () => {
    mockApollo({ found: false, asyncPending: true, asyncRequestId: 'req-456' });
    jest.spyOn(crmDb, 'getEnrichmentCacheItem').mockResolvedValue({
      rawData: { status: 'no_email' },
    } as any);

    const deps = buildIdentityDeps('user-1');
    const result = await deps.apolloBrokerChain(
      { firstName: 'Jane', lastName: 'Doe', domain: 'acme.com' },
      { listId: 'list-1', leadId: 'lead-1' },
    );

    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to confirm the baseline**

Run: `npx jest enrichmentV3RealDepsApolloBroker`
Expected: PASS — the inline loop already implements this behaviour. (This task is a refactor; the test protects against regression. Running it green now establishes the baseline.)

- [ ] **Step 3: Export `waitForApolloAsyncResult`**

In `backend/src/services/enrichmentWaterfall.ts`, change line 68 from:

```typescript
async function waitForApolloAsyncResult(
```

to:

```typescript
export async function waitForApolloAsyncResult(
```

- [ ] **Step 4: Import it into `enrichmentV3RealDeps.ts`**

Add to the import block of `backend/src/services/enrichmentV3RealDeps.ts` (after line 24, `import { FIELD_GROUPS } from './enrichmentGroups';`):

```typescript
import { waitForApolloAsyncResult } from './enrichmentWaterfall';
```

(No import cycle: `enrichmentWaterfall.ts` does not import `enrichmentV3RealDeps.ts`.)

- [ ] **Step 5: Replace the inline poll loop**

In `apolloBrokerChain`, replace lines 232-258 (the inline polling block — from the `// Inline polling logic` comment through the closing brace of the second `if (key) { ... }`):

```typescript
          // Inline polling logic: up to 30s with backoff schedule.
          const budgetMs = 30_000;
          if (key) {
            const intervals = [2000, 5000, 10000, 15000];
            let attempt = 0;
            const start = Date.now();
            while (true) {
              const remaining = budgetMs - (Date.now() - start);
              if (remaining <= 0) return null;
              const row: any = await crmDb.getEnrichmentCacheItem(key.canonicalId, key.sk).catch(() => null);
              const status = row?.rawData?.status;
              if (status === 'completed') {
                const result = row.rawData.result || {};
                if (typeof result.email === 'string' && result.email.length > 0) {
                  return { email: result.email, emailStatus: result.emailStatus };
                }
                return null;
              }
              if (status === 'no_email' || status === 'rejected') return null;
              const remainingAfterRead = budgetMs - (Date.now() - start);
              if (remainingAfterRead <= 0) return null;
              const baseDelay = intervals[Math.min(attempt, intervals.length - 1)];
              const delay = Math.min(baseDelay, remainingAfterRead);
              await new Promise((r) => setTimeout(r, delay));
              attempt++;
            }
          }
```

with:

```typescript
          // Poll the placeholder row for the webhook result — shared logic
          // with the Tier 3 waterfall path. 30s budget: the identity path
          // waits less than the waterfall's configurable 90s default.
          const polled = await waitForApolloAsyncResult(f.asyncRequestId, 30_000);
          if (polled?.email) {
            return { email: polled.email, emailStatus: polled.emailStatus };
          }
```

The surrounding `if (f.asyncPending && f.asyncRequestId) { const key = ...; if (key) { ...putEnrichmentCacheItem... } <replaced block> }` structure is preserved — `key` is still declared and still used for the placeholder write; only the poll loop is replaced. `waitForApolloAsyncResult` recomputes the cache key internally from `f.asyncRequestId`.

- [ ] **Step 6: Run the test to verify it still passes**

Run: `npx jest enrichmentV3RealDepsApolloBroker`
Expected: PASS — behaviour is unchanged; the poll is now the shared implementation.

- [ ] **Step 7: Verify compilation and waterfall tests**

Run: `npx tsc`
Expected: no errors.

Run: `npx jest enrichmentWaterfall enrichmentV3RealDeps`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/services/enrichmentWaterfall.ts backend/src/services/enrichmentV3RealDeps.ts backend/src/__tests__/enrichmentV3RealDepsApolloBroker.test.ts
git commit -m "refactor(enrichment): share waitForApolloAsyncResult between waterfall and v3 deps"
```

---

### Task 9: Release note for the large-list fix (Task 6)

Task 6 is the only user-facing change — large lead lists are now fully enriched. Add a release note. The other tasks are internal (refactors, dead-code removal, perf) and need no note.

**Files:**
- Modify: `backend/src/docs/user-release.ts`

- [ ] **Step 1: Read the file head**

Run: `head -20 backend/src/docs/user-release.ts`
Identify the exported array declaration (e.g. `export const ... = [`) so the new entry can be inserted as the **first** array element (entries are newest-first).

- [ ] **Step 2: Insert the new entry**

Insert this object as the first element of the array (immediately after the `[` that opens it):

```typescript
  {
    date: '2026-05-21',
    changes: [
      'Fixed: CRM Enrichment Now Processes Every Lead in Large Lists',
      '- Enriching a large lead list could silently stop after the first batch of leads, leaving the rest of the list un-enriched with no error',
      '- Enrichment now pages through the entire list, so every lead is processed regardless of list size',
    ],
  },
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/docs/user-release.ts
git commit -m "docs: add 2026-05-21 release note for CRM enrichment large-list fix"
```

---

## Final Verification

- [ ] **Full type check:** from `backend/`, run `npx tsc` — expected: no errors.
- [ ] **Full test suite:** from `backend/`, run `npm test` — expected: all tests pass.
- [ ] **Coverage (pre-deploy gate):** CI requires ≥95% on statements/branches/functions/lines. Run `npm run test:coverage -- --coverageReporters=text --coverageReporters=json-summary` and confirm the new branches in Tasks 5, 6, 7 are covered (they are exercised by the new tests).
- [ ] **Review commit history:** `git log --oneline origin/main..HEAD` — expected: 9 focused commits, one per task, none with a `Co-Authored-By: Claude` trailer.
- [ ] Open a PR with `gh pr create` (do not use `--delete-branch` on merge).

## Self-Review Checklist (completed during planning)

- **Spec coverage:** all 8 in-scope verified findings (V-RU4, V-EN5, V-EN9, V-EN1, V-PF6, V-PF5, V-PF1, V-RU1) map to Tasks 1-8; Task 9 covers the release note. Deferred items are explicitly listed and excluded.
- **Placeholders:** none — every step contains the actual code or command.
- **Type consistency:** `STANDARD_ENRICHABLE_FIELDS` (Task 1), `SiblingFieldMappingTable` shape (Task 5), `LeadRecord`/`PerLeadOutcome` (Task 7), `waitForApolloAsyncResult` signature `(requestId: string, budgetMs: number)` (Task 8) all verified against the current source.
- **Cross-repo:** confirmed `searchWebFailed` is read by the customer-portal — Task 4 keeps the result field and removes only dead code (see Scope note).
- **Task ordering:** trivial/safe first (1-3), then small (4-5), then medium (6-8). Task 7 explicitly depends on Task 4.
