# Design: Migrate Emma's Lead Enrichment to the V3 Engine

**Date:** 2026-05-21
**Status:** Approved design — ready for implementation planning
**Area:** Backend (`backend/src/emma/`, `backend/src/services/`)

## Problem

Lead enrichment requested through Emma (the in-app chatbot) does not work properly:
enrichment jobs complete, but requested fields come back empty, with results
varying run-to-run.

### Root cause

There are two separate CRM lead-enrichment engines, and Emma is wired to the wrong one.

| | CRM UI | Emma |
|---|---|---|
| Entry point | `POST /api/crm/lists/:listId/leads/enrich-v3` | `enrich_leads_preview` / `enrich_leads_execute` tools |
| Engine | **V3** — `runEnrichment` (`crmEnrichmentServiceV3.ts:704`) | **Legacy** — `CrmEnrichmentService` (`crmEnrichmentService.ts`) |
| Config | UI saves a V3 `EnrichmentConfig` to `AW-LeadLists.enrichmentConfig` via a separate `PUT /enrichment-config`, then runs | Writes no config at all |

The legacy engine Emma uses reads a boolean `enrichmentFieldConfig` from the lead
list to decide which fields the enrich.so specialists may write. Emma never sets
one, so it falls back to defaults — 5 standard fields ON, 7 extended fields OFF
(`summary`, `skills`, `headline`, `location`, `connectionCount`, `pastCompanies`,
`education`). Those fields get fetched but the lead-side write is gated off, so
they come back empty. On top of that, the legacy engine lacks V3's reliability
work (LinkedIn URL hallucination guards, critic pass, identity resolver, Apollo
tiers, smart fields), which is the source of the run-to-run variation.

## Goals

- Emma-driven enrichment produces the same quality results as the CRM UI.
- Both Emma enrichment tools (`enrich_leads_preview`, `enrich_leads_execute`) run
  on the V3 `runEnrichment` engine.
- Emma never mutates the user's UI-saved enrichment config.

## Non-goals

- Retiring the legacy `CrmEnrichmentService` (still used by `enrich_lead_custom`
  and possibly other routes — out of scope).
- Auto-adding enriched fields to the CRM grid's `displayFields`.
- Letting Emma specify field types (number/enum/date) — all Emma fields default
  to `string`; smart-field classification may still infer a type as a bonus.
- A global cache-refresh control for Emma.

## Approach

Re-point both Emma enrichment tools at V3 `runEnrichment`. V3 is **config-in** —
it accepts an `EnrichmentConfig` as a direct argument and does not read it from
the lead list — so Emma builds the config in memory per run and never persists it.

A *raw* config is not sufficient. Without `aliasFor` resolution and smart-field
classification, V3's `routeFields` sends every custom field to web-search-only
extraction (missing Apollo / LinkedIn structured data) and treats intended smart
fields as plain fetched fields. The CRM UI gets this processing because its save
path (`setEnrichmentConfig`) does it. Emma must run the same processing — minus
the persistence.

### Why config stays in memory

`setEnrichmentConfig` **overwrites** the entire stored `enrichmentConfig`. If
Emma persisted, it would wipe whatever the user configured in the UI's Enrichment
Config dialog. Therefore Emma builds and processes the config in memory only.

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

A pure function that maps Emma tool arguments to a raw V3 config:

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

### 3. Rewrite the two Emma tool handlers (`backend/src/emma/tools.ts`)

`enrich_leads_preview` (def `tools.ts:5623-5702`, handler `5703-5723`) and
`enrich_leads_execute` (def `tools.ts:5725-5798`, handler `5799-5819`) are
rewritten. Shared handler flow:

1. `buildRawEnrichmentConfig(args, userId)` → raw config.
2. `processEnrichmentConfig(rawConfig, list_id, userId, processingDeps)` →
   processed config + `warnings`.
3. Build `RunEnrichmentInput`:
   - **preview:** `{ listId, userId, config, mode: 'preview', leadIds }` where
     `leadIds` = first 2 of `lead_ids` if provided, else the first 2 leads of the
     list (`crmDb.getLeadsByListId`).
   - **execute:** `{ listId, userId, config, mode: 'enrich', leadIds }` where
     `leadIds` = `lead_ids` if provided, else omitted (whole list).
4. Build `RunEnrichmentOptions`: `{ userId, socketId: context.socketId,
   socketEmit: context.socketEmit }`. Default event names
   (`crm-enrichment-progress` / `crm-enrichment-complete`) are kept so the CRM
   page progress bar still works when Emma is used from the CRM page.
5. `runEnrichment(input, buildOrchestratorDeps(userId), options)`
   (`buildOrchestratorDeps` from `enrichmentV3RealDeps.ts:664`).
6. Return a summary, plus any config-processing `warnings`:
   - **preview:** the per-lead sample extracted values from the V3 preview result.
   - **execute:** `processedCount`, `failedCount`, `failureBreakdown`, etc.

The tool **descriptions** are updated so Emma's LLM understands the new schema.

### 4. Shared config-processing deps factory

The `llmInferAliases`, `llmClassifySmartFields`, and `readListConfig` dep
implementations currently live inline in the `crm.ts` route (`crm.ts:97-172`).
Extract them into a reusable `buildConfigProcessingDeps(userId): ConfigProcessingDeps`
factory so both the `crm.ts` route and the Emma handlers construct them the same
way.

## Tool schema changes

### Before (legacy)

`list_id`, `instruction`, `output_fields` (`string[]`), `sources`,
`sources_per_field`, `field_descriptions`, `linkedin_search_template`, `filters`,
`force_overwrite`, `force_refresh_cache`.

### After (V3)

| Field | Type | Notes |
|---|---|---|
| `list_id` | `string` (required) | unchanged |
| `output_fields` | `Array<{ name, instruction, overwrite_policy? }>` (required) | per-field instruction maps 1:1 to V3; `overwrite_policy` is `"fill_if_empty" \| "always_overwrite"`, optional, defaults to `"fill_if_empty"` |
| `lead_ids` | `string[]` (optional) | subset to enrich; omit = whole list. Replaces `filters` |

Dropped, with rationale:

- `instruction` (top-level) — V3 instructions are per-field.
- `sources`, `sources_per_field` — V3 routes data sources internally through its
  waterfall (CRM history → Apollo → enrich.so → LinkedIn → web search).
- `field_descriptions` — folded into `output_fields[].instruction`.
- `linkedin_search_template` — V3 uses fixed LinkedIn lookup logic.
- `force_overwrite` — replaced by per-field `output_fields[].overwrite_policy`.
- `force_refresh_cache` — no clean V3 equivalent; cache TTLs handle freshness.

## Data flow

```
Emma LLM calls enrich_leads_execute
  -> buildRawEnrichmentConfig(args, userId)              [pure]
  -> processEnrichmentConfig(raw, listId, userId, deps)  [0-2 batched LLM calls + 1 DB read]
       - alias resolution (Apollo canonical-group routing)
       - smart-field classification
       - validation (may throw ConfigValidationError)
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
- `runEnrichment` failures are caught and returned as an error summary.
- An empty list, or an invalid `list_id`, returns an informative error.

## Testing (TDD — backend logic)

Per project rule, backend logic changes are test-first. Run `npx tsc` after every
`.ts` edit, including test files.

- **`buildRawEnrichmentConfig`** — invalid inputs (empty `output_fields`, missing
  `name`, missing `instruction`); boundary (single field, many fields); per-field
  `overwrite_policy` present vs. omitted → resolved `overwritePolicy`; happy path
  produces a well-formed `EnrichmentConfig`.
- **`processEnrichmentConfig` extraction** — all existing `setEnrichmentConfig`
  tests stay green (proves the refactor is behavior-preserving); new tests verify
  `processEnrichmentConfig` resolves aliases, classifies smart fields, validates,
  and does **not** write to DynamoDB.
- **Emma tool handlers** — extend `backend/src/__tests__/emma.enrichLeads.test.ts`:
  tool registration and new input schema; handler calls `runEnrichment` (mocked)
  with the V3 input shape; preview uses `mode: 'preview'` with 2 lead IDs; execute
  uses `mode: 'enrich'`; `ConfigValidationError` is surfaced as a tool error;
  config-processing `warnings` are surfaced in the result.

## Open questions

None — all design decisions are resolved.

## Out of scope / future work

- Retiring the legacy `CrmEnrichmentService` once `enrich_lead_custom` and any
  other consumers are migrated.
- Auto-adding enriched fields to the CRM grid (`displayFields`).
- Emma-specified typed fields (number/enum/date).
- A global cache-refresh control for Emma enrichment.
