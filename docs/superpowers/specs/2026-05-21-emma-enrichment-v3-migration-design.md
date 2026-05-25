# Design: Migrate Emma's Lead Enrichment to the V3 Engine

**Date:** 2026-05-21
**Status:** Approved design — ready for implementation planning
**Area:** Backend (`backend/src/emma/`, `backend/src/services/`)
**Revision:** 3 — incorporates CTO review (root cause confirmed, batch guardrails,
execution cap, `enrich_lead_custom` included, observability) and a detailed
end-to-end Playwright test plan on the cloud test environment.

## Problem

Lead enrichment requested through Emma (the in-app chatbot) does not work
properly: enrichment jobs complete, but requested fields come back empty, with
results varying run-to-run.

### Root cause (confirmed)

Emma is wired to the **legacy** enrichment engine, not the **V3** engine the CRM
UI uses.

| | CRM UI | Emma |
|---|---|---|
| Entry point | `POST /api/crm/lists/:listId/leads/enrich-v3` | `enrich_leads_preview` / `enrich_leads_execute` / `enrich_lead_custom` tools |
| Engine | **V3** — `runEnrichment` (`crmEnrichmentServiceV3.ts:704`) | **Legacy** — `CrmEnrichmentService` (`crmEnrichmentService.ts`) |
| Config | UI saves a V3 `EnrichmentConfig` to `AW-LeadLists.enrichmentConfig` via `PUT /enrichment-config`, then runs | Writes no config at all |

The legacy engine reads a boolean `enrichmentFieldConfig` from the lead list to
decide which fields the enrich.so specialists may write. Emma never sets one, so
it falls back to defaults — 5 standard fields ON, 7 extended fields OFF
(`summary`, `skills`, `headline`, `location`, `connectionCount`, `pastCompanies`,
`education`). Those fields get fetched but the lead-side write is gated off, so
they come back empty. The legacy engine also lacks V3's reliability work
(LinkedIn URL hallucination guards, critic pass, identity resolver, Apollo tiers,
smart fields), which produces the run-to-run variation.

## Goals

- Emma-driven enrichment produces the same quality results as the CRM UI.
- All three Emma enrichment tools (`enrich_leads_preview`, `enrich_leads_execute`,
  `enrich_lead_custom`) run on the V3 `runEnrichment` engine.
- Emma never mutates the user's UI-saved enrichment config.
- Emma-initiated runs cannot blow up cost, quota, or chat-turn latency.

## Non-goals

- Deleting the legacy `CrmEnrichmentService` (still referenced by non-Emma CRM
  routes — see "Legacy consumers" below). Removal is future work.
- Auto-adding enriched fields to the CRM grid's `displayFields`.
- Letting Emma specify field types (number/enum/date) — all Emma fields default
  to `string`; smart-field classification may still infer a type as a bonus.
- A global cache-refresh control for Emma.

## Approach

Re-point all three Emma enrichment tools at V3 `runEnrichment`. V3 is
**config-in** — it accepts an `EnrichmentConfig` as a direct argument and does not
read it from the lead list — so Emma builds the config in memory per run and
never persists it.

A *raw* config is not sufficient. Without `aliasFor` resolution and smart-field
classification, V3's `routeFields` sends every custom field to web-search-only
extraction (missing Apollo / LinkedIn structured data) and treats intended smart
fields as plain fetched fields. The CRM UI gets this processing via its save path
(`setEnrichmentConfig`). Emma must run the same processing — minus persistence.

### Why config stays in memory

`setEnrichmentConfig` **overwrites** the entire stored `enrichmentConfig`. If
Emma persisted, it would wipe whatever the user configured in the UI's Enrichment
Config dialog. Emma therefore builds and processes the config in memory only.

New enriched **field names** still become available columns automatically: in
execute mode, writing leads via `crmDb.setLeadFields` (`db.ts:6471-6643`) syncs
`customFields.X` into the parent list's `fieldNames` (`mergeFieldNames`). No extra
code is needed for column registration. Preview mode writes nothing, so it
registers nothing — correct behavior.

## Components

### 1. Extract `processEnrichmentConfig` (refactor `enrichmentConfigService.ts`)

`setEnrichmentConfig` (`enrichmentConfigService.ts:411-564`) currently performs,
in order:

1. Heuristic alias inference (`inferAliasFor`) + stripping of client-supplied
   classification keys — deterministic, no I/O.
2. LLM alias fallback (`deps.llmInferAliases`) — 1 batched LLM call, fails soft.
3. Smart-tag restoration from the stored config (`deps.readListConfig`) — 1 DB
   read, fails soft.
4. Smart-field classification (`deps.llmClassifySmartFields`) — 1 batched LLM
   call, fails soft; may also override field `type` / `enumOptions`.
5. Validation (`validateConfig`) — may **throw** `ConfigValidationError`.
6. Audit stamping (`updatedAt`, `updatedBy`).
7. DynamoDB write (`deps.writeListConfig`).

Steps 1–6 build an immutable local config; step 7 is an isolated trailing write
with no feedback into the config. Extract steps 1–6 into:

```ts
processEnrichmentConfig(
  rawConfig: EnrichmentConfig,
  listId: string,
  userId: string,
  deps: ConfigProcessingDeps,
): Promise<{ config: EnrichmentConfig; warnings: string[] }>
```

`setEnrichmentConfig` becomes `processEnrichmentConfig(...)` followed by
`deps.writeListConfig(...)`. Behavior of the existing UI path is unchanged.

`ConfigProcessingDeps` is a narrowed subset of `ConfigServiceDeps`
(`enrichmentConfigService.ts:166-188`) containing only `readListConfig`,
`llmInferAliases`, `llmClassifySmartFields` — it excludes `writeListConfig`.

### 2. Config mapper (new helper, `backend/src/emma/`)

A pure function mapping Emma tool arguments to a raw V3 config:

```ts
buildRawEnrichmentConfig(
  args: EnrichLeadsToolArgs,
  userId: string,
): EnrichmentConfig
```

Mapping:

- Each `output_fields[]` entry → one `EnrichmentFieldConfig`:
  - `name` ← `field.name`
  - `instruction` ← `field.instruction`
  - `type` ← `'string'`
  - `include` ← `true`
  - `overwritePolicy` ← `field.overwrite_policy ?? 'fill_if_empty'`
- `EnrichmentConfig.globalOverwriteDefault` ← `'fill_if_empty'` (constant)
- `schemaVersion` ← `1`
- `updatedAt` ← current ISO timestamp
- `updatedBy` ← `userId`

Being pure, this is straightforward to unit-test.

### 3. Shared config-processing deps factory

The `llmInferAliases`, `llmClassifySmartFields`, and `readListConfig` dep
implementations currently live inline in the `crm.ts` route (`crm.ts:97-172`).
Extract them into a reusable `buildConfigProcessingDeps(userId): ConfigProcessingDeps`
factory so both the `crm.ts` route and the Emma handlers construct them the same
way.

### 4. Rewrite the three Emma tool handlers (`backend/src/emma/tools.ts`)

`enrich_leads_preview` (def `tools.ts:5623-5702`, handler `5703-5723`),
`enrich_leads_execute` (def `5725-5798`, handler `5799-5819`), and
`enrich_lead_custom` (`5821-5936`) are rewritten on a shared helper.

**Shared handler flow:**

1. `buildRawEnrichmentConfig(args, userId)` → raw config.
2. `processEnrichmentConfig(rawConfig, list_id, userId, processingDeps)` →
   processed config + `warnings`.
3. Resolve the target lead set and enforce the cap (see Component 5).
4. Build `RunEnrichmentInput`:
   - **preview:** `{ listId, userId, config, mode: 'preview', leadIds }` —
     `leadIds` = 2 representative sample leads (see Component 6).
   - **execute:** `{ listId, userId, config, mode: 'enrich', leadIds }` —
     `leadIds` = `lead_ids` if provided, else omitted (whole list).
   - **custom (single lead):** `{ listId, userId, config, mode: 'enrich',
     leadIds: [leadId] }`.
5. Build `RunEnrichmentOptions`: `{ userId, socketId: context.socketId,
   socketEmit: context.socketEmit }`. Default event names
   (`crm-enrichment-progress` / `crm-enrichment-complete`) are kept so the CRM
   page progress bar still works when Emma is used from the CRM page.
6. `runEnrichment(input, buildOrchestratorDeps(userId), options)`
   (`buildOrchestratorDeps` from `enrichmentV3RealDeps.ts:664`).
7. Return a summary, plus any config-processing `warnings`:
   - **preview:** the per-lead sample extracted values from the V3 preview result.
   - **execute / custom:** `processedCount`, `failedCount`, `failureBreakdown`.

### 5. Batch guardrail — blocking with a hard cap

`enrich_leads_execute` blocks the chat turn until the run completes. To bound
cost, quota, and latency:

- A configurable cap `EMMA_ENRICH_MAX_LEADS` (default **500**) limits the number
  of leads a single `enrich_leads_execute` call may process.
- Before running, the handler resolves the effective lead count (length of
  `lead_ids` if provided, else the list's lead count via `crmDb`). If it exceeds
  the cap, the tool **does not run** — it returns a clear error instructing the
  user to narrow the set with `lead_ids` or use the CRM UI for large lists.
- The default should be tuned against observed run durations once telemetry
  exists; it is an env var precisely so it can be adjusted without a deploy.
- `enrich_leads_preview` (2 leads) and `enrich_lead_custom` (1 lead) are
  inherently under the cap — no check needed.
- Source-level overspend is still bounded by V3's existing per-source quota
  guards (`apolloQuota.ts`, `enrichSoQuota.ts`); the cap is the Emma-side limit,
  not a replacement for those.

### 6. Representative preview sample

Preview must show useful results, or the user concludes enrichment is still
broken. Instead of "first 2 leads", the handler selects 2 leads that have
identity data (a non-empty `email` or `linkedin`), falling back to the first
available leads only if fewer than 2 qualify. If `lead_ids` is provided, the
sample is drawn from that set.

## Tool schema changes

### Before (legacy)

`list_id`, `instruction`, `output_fields` (`string[]`), `sources`,
`sources_per_field`, `field_descriptions`, `linkedin_search_template`, `filters`,
`force_overwrite`, `force_refresh_cache`. (`enrich_lead_custom` additionally takes
a single `lead_id`.)

### After (V3)

| Field | Type | Notes |
|---|---|---|
| `list_id` | `string` (required) | unchanged |
| `output_fields` | `Array<{ name, instruction, overwrite_policy? }>` (required) | per-field instruction maps 1:1 to V3; `overwrite_policy` is `"fill_if_empty" \| "always_overwrite"`, optional, defaults to `"fill_if_empty"` |
| `lead_ids` | `string[]` (optional, `enrich_leads_execute`) | subset to enrich; omit = whole list. Replaces `filters`. Subject to the cap |
| `lead_id` | `string` (required, `enrich_lead_custom`) | unchanged — single-lead target |

Dropped, with rationale:

- `instruction` (top-level) — V3 instructions are per-field.
- `sources`, `sources_per_field` — V3 routes data sources internally through its
  waterfall (CRM history → Apollo → enrich.so → LinkedIn → web search).
- `field_descriptions` — folded into `output_fields[].instruction`.
- `linkedin_search_template` — V3 uses fixed LinkedIn lookup logic.
- `force_overwrite` — replaced by per-field `output_fields[].overwrite_policy`.
- `force_refresh_cache` — no clean V3 equivalent; cache TTLs handle freshness.

This is a breaking change to the tool input shape. There is no persisted state in
the old shape — tool schemas are defined at registration and tool calls are
per-turn — so no data migration is required. The work is: update the tool
**definitions/descriptions** and any Emma system-prompt or few-shot examples that
reference the old argument names, and update the unit tests.

## Data flow

```
Emma LLM calls enrich_leads_execute
  -> buildRawEnrichmentConfig(args, userId)              [pure]
  -> processEnrichmentConfig(raw, listId, userId, deps)  [0-2 batched LLM calls + 1 DB read]
       - alias resolution (Apollo canonical-group routing)
       - smart-field classification
       - validation (may throw ConfigValidationError)
  -> resolve lead set; enforce EMMA_ENRICH_MAX_LEADS cap
  -> runEnrichment({ listId, userId, config, mode, leadIds },
                   buildOrchestratorDeps(userId),
                   { userId, socketId, socketEmit })
       - V3 waterfall: identity -> Apollo -> enrich.so -> LinkedIn -> web -> critic
       - setLeadFields -> leads written; list.fieldNames auto-synced
  -> return summary + warnings
```

## Error handling

- `processEnrichmentConfig` already fails soft on LLM and DB errors (alias
  fallback and smart classification are each wrapped in try/catch). A failure
  degrades a field to web-only enrichment rather than breaking the run.
- `validateConfig` **throws** `ConfigValidationError` for duplicate field names,
  reserved names (`leadId`, `listId`, `enrichmentMetadata`, `customFields`,
  `createdAt`, `updatedAt`), and enum fields without options. The Emma handler
  catches this and returns a clear error message so Emma can tell the user and
  retry with corrected field names.
- Exceeding `EMMA_ENRICH_MAX_LEADS` returns an actionable error, not a partial run.
- `runEnrichment` failures are caught and returned as an error summary.
- An empty list, or an invalid `list_id` / `lead_id`, returns an informative error.

## Observability & success criteria

- **Engine tagging:** each Emma enrichment run logs which engine executed (V3),
  the `runId`, `listId`, lead count, and field count — so post-ship we can
  confirm Emma traffic is on V3.
- **Outcome logging:** log the V3 result summary (`processedCount`, `failedCount`,
  `failureBreakdown`, `tierFillBreakdown`, `durationMs`) for every Emma run.
- **Success criterion:** after rollout, Emma enrichment jobs show a non-empty
  field fill rate comparable to CRM-UI V3 jobs (the empty-extended-field failure
  mode no longer occurs). This is verifiable from the `AW-EnrichmentJobs` records
  and the outcome logs above.

## Legacy consumers

A pre-implementation task enumerates every remaining reference to
`CrmEnrichmentService`. Known non-Emma consumers include CRM routes such as
`enrich-web` and `enrich-with-apollo` in `crm.ts`. Because those remain, the
legacy service is **not** deleted in this spec. Once all consumers are migrated,
removal becomes a clean follow-up.

## Testing (TDD — backend logic)

Per project rule, backend logic changes are test-first. Run `npx tsc` after every
`.ts` edit, including test files. CI requires ≥95% coverage on statements,
branches, functions, and lines.

- **`buildRawEnrichmentConfig`** — invalid inputs (empty `output_fields`, missing
  `name`, missing `instruction`); boundary (single field, many fields); per-field
  `overwrite_policy` present vs. omitted → resolved `overwritePolicy`; happy path
  produces a well-formed `EnrichmentConfig`.
- **`processEnrichmentConfig` extraction** — all existing `setEnrichmentConfig`
  tests stay green (proves the refactor is behavior-preserving). Additionally,
  **verify the soft-fail branches are actually exercised** — alias-fallback
  failure, classification failure, restoration miss — not merely that lines are
  covered for the CI gate. New tests verify `processEnrichmentConfig` resolves
  aliases, classifies smart fields, validates, and does **not** write to DynamoDB.
- **Cap enforcement** — a run over `EMMA_ENRICH_MAX_LEADS` is rejected with the
  actionable error and never calls `runEnrichment`; a run at/under the cap runs.
- **Preview sampling** — selects leads with identity data; falls back gracefully
  when fewer than 2 qualify.
- **Emma tool handlers** — extend `backend/src/__tests__/emma.enrichLeads.test.ts`:
  tool registration and new input schema for all three tools; handlers call
  `runEnrichment` (mocked) with the V3 input shape; preview uses `mode: 'preview'`
  with 2 lead IDs; execute uses `mode: 'enrich'`; `enrich_lead_custom` uses
  `mode: 'enrich'` with a single-element `leadIds`; `ConfigValidationError` is
  surfaced as a tool error; config-processing `warnings` are surfaced in the
  result.

## End-to-end testing (Playwright on the cloud test environment)

Unit tests prove the logic; Playwright E2E tests prove the feature works for a
real user. These run a real browser (via the `mcp__playwright__browser_*` tools)
against the **cloud test environment**, driving Emma in the customer portal.

### Environment & setup

- Launch/refresh the env: `./test-env/test-env.sh launch`, then
  `./test-env/test-env.sh sync` **after every code change** (mandatory project
  rule). All E2E cases run post-`sync` against the test env URL.
- Accounts: `test@example.com` / `Test123!` (admin / full access);
  `test1@example.com` / `Test123!` (Basic tier) for any subscription-gated check.
- Seed data required on the test env before the run:
  - **List A** — a small CRM lead list (~5–10 leads): at least 2 leads with both
    `email` and `linkedin` populated, and at least 1 lead with sparse data.
  - **List B** — a list with more leads than `EMMA_ENRICH_MAX_LEADS`, for the cap
    test (the env var may be lowered on the test env to keep the list small).
  - **List C** — a list with a pre-saved UI `enrichmentConfig` (saved via the
    Enrichment Config dialog) for the non-clobber test.

### Test matrix — every case

Each case: establish pre-state → drive the action through Emma chat → assert.

1. **Preview happy path** — ask Emma to preview enrichment of List A with 2+
   custom fields. Assert: Emma calls `enrich_leads_preview`; sample values shown
   for exactly 2 leads; no lead record mutated (CRM grid unchanged after).
2. **Execute — standard fields** — ask Emma to enrich `title` / `company` on
   List A. Assert: run completes, `failedCount` = 0, CRM grid shows populated
   values.
3. **Execute — extended fields (the regression)** — ask Emma to enrich `summary`,
   `skills`, `headline`, `location` (the fields the legacy engine silently
   dropped). Assert: values are **non-empty** after the run. Core proof the bug
   is fixed.
4. **Apollo-routed field quality** — enrich a field that should resolve from
   Apollo structured data (e.g. company tech stack / revenue). Assert: value
   populates and its enrichment metadata/source shows Apollo (not a web-only
   guess) — proves config processing routed the field correctly.
5. **Per-field overwrite policy** — run a mix of `fill_if_empty` and
   `always_overwrite` fields against leads with some pre-populated values.
   Assert: `fill_if_empty` leaves existing values untouched; `always_overwrite`
   replaces them.
6. **Subset via `lead_ids`** — ask Emma to enrich only specific leads of List A.
   Assert: only those leads change; the rest are untouched.
7. **Single-lead enrichment (`enrich_lead_custom`)** — ask Emma to enrich one
   named lead. Assert: that lead's fields populate; no other lead changes.
8. **Cap enforcement** — ask Emma to enrich List B (over `EMMA_ENRICH_MAX_LEADS`).
   Assert: Emma returns the actionable error; no enrichment runs (grid
   unchanged, no new `AW-EnrichmentJobs` record).
9. **Config validation error** — ask Emma to enrich with a duplicate field name,
   and separately with a reserved name (`leadId`). Assert: Emma surfaces a clear
   validation error and does not run.
10. **Config-processing warnings** — request two route-colliding fields (e.g.
    `company` and `company_name`). Assert: run completes; the warning is surfaced
    in Emma's response.
11. **UI config not clobbered** — on List C, note the saved `enrichmentConfig`;
    run an Emma enrichment with different fields; reopen the Enrichment Config
    dialog. Assert: the UI-saved config is unchanged.
12. **New field column auto-registers** — enrich a brand-new custom field via
    Emma on List A; open "Configure Display Fields". Assert: the new field
    appears as a selectable column.
13. **Progress updates** — during an Emma execute run started from the CRM page,
    assert the CRM progress bar/banner updates (default event names retained).
14. **Delegated session** — as admin, delegate into a customer account, run an
    Emma enrichment. Assert: it works; leads are enriched under the target user.
15. **Error paths** — invalid `list_id`, an empty list, and an invalid `lead_id`
    for `enrich_lead_custom`. Assert: Emma returns informative errors, no crash.
16. **Engine confirmation** — after an Emma run, verify via backend logs or the
    `AW-EnrichmentJobs` record that the **V3** engine executed, not legacy.

## Open questions

None — all design decisions are resolved.

## Out of scope / future work

- Deleting the legacy `CrmEnrichmentService` after all consumers migrate.
- Auto-adding enriched fields to the CRM grid (`displayFields`).
- Emma-specified typed fields (number/enum/date).
- An async, non-blocking execution model for very large Emma enrichment runs
  (current spec uses blocking + hard cap).
- A global cache-refresh control for Emma enrichment.
