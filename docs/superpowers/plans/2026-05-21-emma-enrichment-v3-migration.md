# Emma Lead Enrichment V3 Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-point Emma's three CRM enrichment tools (`enrich_leads_preview`, `enrich_leads_execute`, `enrich_lead_custom`) from the legacy `CrmEnrichmentService` to the V3 `runEnrichment` engine, so Emma-driven enrichment produces the same quality results as the CRM UI.

**Architecture:** Emma builds a V3 `EnrichmentConfig` in memory per run, processes it through the same alias-resolution / smart-field-classification pipeline the CRM UI uses (extracted from `setEnrichmentConfig` into a new `processEnrichmentConfig`), then calls `runEnrichment` directly — never persisting the config. A hard per-call lead cap bounds cost and latency. The legacy `CrmEnrichmentService` is left in place for its remaining non-Emma consumers.

**Tech Stack:** Node.js / TypeScript, Express, Jest, DynamoDB, Socket.IO. Frontend verification via Playwright MCP against the cloud test environment.

**Spec:** `docs/superpowers/specs/2026-05-21-emma-enrichment-v3-migration-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `backend/src/services/enrichmentConfigService.ts` | Modify | Add `ConfigProcessingDeps` type + `processEnrichmentConfig`; `setEnrichmentConfig` delegates to it then writes |
| `backend/src/services/enrichmentConfigDeps.ts` | Create | `buildConfigServiceDeps()` / `buildConfigProcessingDeps()` — real DDB + LLM dep implementations, moved out of `crm.ts` |
| `backend/src/routes/crm.ts` | Modify | Replace the inline `enrichmentConfigDeps` object + `heuristicTypeSuggestion` with an import from `enrichmentConfigDeps.ts` |
| `backend/src/emma/enrichmentToolConfig.ts` | Create | Pure mapper `buildRawEnrichmentConfig` + `getEmmaEnrichMaxLeads` + tool arg types |
| `backend/src/emma/enrichmentToolRunner.ts` | Create | `runEmmaEnrichment` (process config → run V3 → map result), `pickPreviewLeadIds`, `resolveExecuteLeadIds` |
| `backend/src/emma/tools.ts` | Modify | Rewrite the 3 enrichment tool registrations (schema + handler) |
| `backend/src/__tests__/enrichmentConfigService.test.ts` | Modify | Add `processEnrichmentConfig` tests; existing `setEnrichmentConfig` tests stay green |
| `backend/src/__tests__/enrichmentToolConfig.test.ts` | Create | Unit tests for `buildRawEnrichmentConfig` + `getEmmaEnrichMaxLeads` |
| `backend/src/__tests__/enrichmentToolRunner.test.ts` | Create | Unit tests for `runEmmaEnrichment`, `pickPreviewLeadIds`, `resolveExecuteLeadIds` |
| `backend/src/__tests__/emma.enrichLeads.test.ts` | Modify | Rewrite for the new tool schemas + V3 wiring |
| `backend/src/docs/user-release.ts` | Modify | Add a user-facing release note |

**Conventions for every task:** run `npx tsc` from `backend/` after every `.ts` edit (including test files). CI requires ≥95% coverage on statements, branches, functions, and lines. Commit messages must not include any AI / co-author identity trailer.

---

## Task 1: Enumerate legacy `CrmEnrichmentService` consumers

No code change — this confirms scope before touching anything.

- [ ] **Step 1: Find all references**

Run from repo root:
```bash
grep -rn "CrmEnrichmentService" backend/src --include=*.ts | grep -v __tests__
```

- [ ] **Step 2: Record the result**

Expected: references in `backend/src/emma/tools.ts` (the 3 tools being migrated) and in non-Emma CRM routes (e.g. `enrich-web`, `enrich-with-apollo` handlers in `backend/src/routes/crm.ts`), plus internal use inside `crmEnrichmentServiceV3.ts` / `enrichmentV3RealDeps.ts` (the `LeadRecord` / `SocketEmitFn` type re-exports and `isPersonalEmailDomain`).

Confirm: **non-Emma consumers exist → the legacy service is NOT deleted by this plan.** If the only consumers turn out to be the 3 Emma tools, note it in the final summary as a follow-up cleanup opportunity, but still do not delete it in this plan. No commit for this task.

---

## Task 2: Extract `processEnrichmentConfig` from `setEnrichmentConfig`

**Files:**
- Modify: `backend/src/services/enrichmentConfigService.ts`
- Test: `backend/src/__tests__/enrichmentConfigService.test.ts`

Currently `setEnrichmentConfig` (`enrichmentConfigService.ts:411-564`) does config processing (steps 1, 2, 3a, 3b, validation, audit stamping) **and** the DynamoDB write. We split processing from persistence so Emma can process a config without persisting it.

- [ ] **Step 1: Write the failing tests**

Open `backend/src/__tests__/enrichmentConfigService.test.ts`. Reuse the existing mock-deps pattern already in that file (a `ConfigServiceDeps` object with jest-mocked methods). Add this describe block at the end of the file, before the final closing brace:

```typescript
describe('processEnrichmentConfig', () => {
  // makeDeps(): returns a fully mocked ConfigServiceDeps. Reuse the helper the
  // existing setEnrichmentConfig tests use. If there is no shared helper,
  // create one mirroring those tests: readListConfig→null, writeListConfig→
  // jest.fn(), loadListFieldNames→[], llmSuggestTypes→[], llmInferAliases→{},
  // llmClassifySmartFields→{}.

  it('resolves heuristic aliases without writing to the DB', async () => {
    const deps = makeDeps();
    const { processEnrichmentConfig } = await import('../services/enrichmentConfigService');
    const { config } = await processEnrichmentConfig(
      {
        listId: 'list-1',
        userId: 'user-1',
        config: {
          fields: [
            { name: 'fundingRound', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
          ],
          globalOverwriteDefault: 'fill_if_empty',
          schemaVersion: 1,
          updatedAt: '2020-01-01T00:00:00.000Z',
          updatedBy: 'old',
        },
      },
      deps,
    );
    expect(config.fields[0].aliasFor).toBe('funding_stage');
    expect(config.updatedBy).toBe('user-1');
    expect(deps.writeListConfig).not.toHaveBeenCalled();
  });

  it('throws ConfigValidationError on a duplicate field name', async () => {
    const deps = makeDeps();
    const { processEnrichmentConfig } = await import('../services/enrichmentConfigService');
    await expect(
      processEnrichmentConfig(
        {
          listId: 'list-1',
          userId: 'user-1',
          config: {
            fields: [
              { name: 'industry', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
              { name: 'industry', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
            ],
            globalOverwriteDefault: 'fill_if_empty',
            schemaVersion: 1,
            updatedAt: '2020-01-01T00:00:00.000Z',
            updatedBy: 'old',
          },
        },
        deps,
      ),
    ).rejects.toThrow(/already in the list/);
  });

  it('survives an llmInferAliases failure (soft-fail branch)', async () => {
    const deps = makeDeps();
    deps.llmInferAliases = jest.fn().mockRejectedValue(new Error('llm down'));
    const { processEnrichmentConfig } = await import('../services/enrichmentConfigService');
    const { config } = await processEnrichmentConfig(
      {
        listId: 'list-1',
        userId: 'user-1',
        config: {
          fields: [
            { name: 'opaque_xyz', type: 'string', instruction: 'something custom', include: true, overwritePolicy: 'fill_if_empty' },
          ],
          globalOverwriteDefault: 'fill_if_empty',
          schemaVersion: 1,
          updatedAt: '2020-01-01T00:00:00.000Z',
          updatedBy: 'old',
        },
      },
      deps,
    );
    expect(config.fields[0].aliasFor).toBeUndefined();
  });

  it('survives an llmClassifySmartFields failure (soft-fail branch)', async () => {
    const deps = makeDeps();
    deps.llmClassifySmartFields = jest.fn().mockRejectedValue(new Error('llm down'));
    const { processEnrichmentConfig } = await import('../services/enrichmentConfigService');
    const { config } = await processEnrichmentConfig(
      {
        listId: 'list-1',
        userId: 'user-1',
        config: {
          fields: [
            { name: 'is_hiring', type: 'string', instruction: 'are they hiring engineers', include: true, overwritePolicy: 'fill_if_empty' },
          ],
          globalOverwriteDefault: 'fill_if_empty',
          schemaVersion: 1,
          updatedAt: '2020-01-01T00:00:00.000Z',
          updatedBy: 'old',
        },
      },
      deps,
    );
    expect(config.fields[0].smartCondition).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest src/__tests__/enrichmentConfigService.test.ts -t processEnrichmentConfig`
Expected: FAIL — `processEnrichmentConfig` is not exported.

- [ ] **Step 3: Add the `ConfigProcessingDeps` type**

In `backend/src/services/enrichmentConfigService.ts`, immediately after the `ConfigServiceDeps` interface (ends at line 188), add:

```typescript
/** Subset of ConfigServiceDeps needed to PROCESS a config (resolve aliases,
 *  classify smart fields, validate) without persisting it. Used by callers
 *  that build a config in memory and run enrichment directly — e.g. Emma. */
export type ConfigProcessingDeps = Pick<
  ConfigServiceDeps,
  'readListConfig' | 'llmInferAliases' | 'llmClassifySmartFields'
>;
```

- [ ] **Step 4: Extract the body into `processEnrichmentConfig`**

Replace the entire current `setEnrichmentConfig` function (`enrichmentConfigService.ts:411-564`) with the two functions below. The body of `processEnrichmentConfig` is the current steps 1 → audit-stamp, verbatim, with the trailing `writeListConfig` removed:

```typescript
/**
 * Process a raw enrichment config: resolve aliasFor (heuristic + LLM),
 * restore + classify smart fields, validate, and stamp audit fields.
 * Does NOT persist. setEnrichmentConfig = processEnrichmentConfig + write.
 */
export async function processEnrichmentConfig(
  input: { listId: string; userId: string; config: EnrichmentConfig },
  deps: ConfigProcessingDeps,
): Promise<{ config: EnrichmentConfig; warnings: string[] }> {
  // Step 1: heuristic alias inference (camelCase, synonym map, standard
  // columns). Cheap, no API call. Catches the easy 80% of cases.
  // Explicit client-supplied aliasFor is preserved.
  let enriched: EnrichmentConfig = {
    ...input.config,
    fields: input.config.fields.map(
      ({ smartCondition: _sc, smartDependencies: _sd, notSmartInstruction: _nsi, ...f }) => ({
        ...f,
        aliasFor: ALIAS_INFERENCE_BLOCKLIST.has(f.name) ? undefined : (f.aliasFor ?? inferAliasFor(f.name)),
      }),
    ),
  };

  // Step 2: LLM fallback for fields the heuristic couldn't resolve.
  const llmCandidates = enriched.fields.filter(f => !f.aliasFor && !ALIAS_INFERENCE_BLOCKLIST.has(f.name));
  if (llmCandidates.length > 0) {
    try {
      const llmAliases = await deps.llmInferAliases(
        llmCandidates.map(f => ({ name: f.name, instruction: f.instruction || '' })),
      );
      enriched = {
        ...enriched,
        fields: enriched.fields.map(f => {
          if (f.aliasFor) return f;
          const llmGuess = llmAliases[f.name];
          if (llmGuess && CANONICAL_FIELD_NAMES.has(llmGuess)) {
            return { ...f, aliasFor: llmGuess };
          }
          return f;
        }),
      };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[enrichmentConfigService] LLM alias inference failed:', err);
    }
  }

  // Step 3a: Restore server-persisted classification keys from DB.
  {
    const storedConfig = await deps.readListConfig(input.listId).catch(() => null);
    const storedByName = new Map(
      (storedConfig?.fields ?? []).map(f => [f.name, f]),
    );
    enriched = {
      ...enriched,
      fields: enriched.fields.map(f => {
        const sf = storedByName.get(f.name);
        if (!sf) return f;
        const restored: Partial<EnrichmentFieldConfig> = {};
        if (sf.smartCondition !== undefined) restored.smartCondition = sf.smartCondition;
        if (sf.smartDependencies !== undefined) restored.smartDependencies = sf.smartDependencies;
        if (sf.notSmartInstruction !== undefined) restored.notSmartInstruction = sf.notSmartInstruction;
        return { ...f, ...restored };
      }),
    };
  }

  // Step 3b: Classify smart fields via LLM.
  const classificationCandidates = enriched.fields.filter(
    f => f.instruction && f.include && (
      f.smartCondition?.trim() !== f.instruction.trim() &&
      f.notSmartInstruction?.trim() !== f.instruction.trim()
    ),
  );
  if (classificationCandidates.length > 0) {
    try {
      const classifications = await deps.llmClassifySmartFields(
        classificationCandidates.map(f => ({ name: f.name, instruction: f.instruction })),
      );
      enriched = {
        ...enriched,
        fields: enriched.fields.map(f => {
          const cls = classifications[f.name];
          if (!cls) return f;

          const VALID_INFERRED_TYPES = new Set(['string', 'number', 'boolean', 'date', 'enum']);
          const inferredType = cls.fieldType && VALID_INFERRED_TYPES.has(cls.fieldType)
            ? cls.fieldType as 'string' | 'number' | 'boolean' | 'date' | 'enum'
            : undefined;
          const validEnumOptions = (cls.enumOptions ?? []).filter(o => typeof o === 'string' && o.trim());
          let typeOverride: Partial<EnrichmentFieldConfig> = {};
          if (inferredType) {
            if (inferredType === 'enum' && validEnumOptions.length > 0) {
              typeOverride = { type: 'enum', enumOptions: validEnumOptions };
            } else if (inferredType !== 'enum') {
              typeOverride = { type: inferredType, enumOptions: undefined };
            }
          }

          if (cls.isSmartField) {
            const validDeps = (cls.dependencies ?? []).filter(d => CANONICAL_FIELD_NAMES.has(d));
            const droppedDeps = (cls.dependencies ?? []).filter(d => !CANONICAL_FIELD_NAMES.has(d));
            if (droppedDeps.length > 0) {
              // eslint-disable-next-line no-console
              console.warn(`[enrichmentConfigService] smart field '${f.name}' had non-canonical deps filtered: ${droppedDeps.join(', ')} — these may be other smart field names (chaining not supported)`);
            }
            const out = { ...f, ...typeOverride, smartCondition: f.instruction, smartDependencies: validDeps };
            delete (out as any).notSmartInstruction;
            return out;
          }
          const out = { ...f, ...typeOverride, notSmartInstruction: f.instruction };
          delete (out as any).smartCondition;
          delete (out as any).smartDependencies;
          return out;
        }),
      };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[enrichmentConfigService] smart field classification failed:', err);
    }
  }

  const { warnings } = validateConfig(enriched);

  // Stamp server-side audit fields, overwriting whatever the client sent.
  const stamped: EnrichmentConfig = {
    ...enriched,
    updatedAt: new Date().toISOString(),
    updatedBy: input.userId,
  };

  return { config: stamped, warnings };
}

export async function setEnrichmentConfig(
  input: { listId: string; userId: string; config: EnrichmentConfig },
  deps: ConfigServiceDeps,
): Promise<{ config: EnrichmentConfig; warnings: string[] }> {
  const { config, warnings } = await processEnrichmentConfig(input, deps);
  await deps.writeListConfig(input.listId, config);
  return { config, warnings };
}
```

`ConfigServiceDeps` is a superset of `ConfigProcessingDeps`, so passing the full `deps` from `setEnrichmentConfig` into `processEnrichmentConfig` type-checks.

- [ ] **Step 5: Run `npx tsc`**

Run: `cd backend && npx tsc`
Expected: no errors.

- [ ] **Step 6: Run the full file's tests**

Run: `cd backend && npx jest src/__tests__/enrichmentConfigService.test.ts`
Expected: PASS — both the new `processEnrichmentConfig` tests and all pre-existing `setEnrichmentConfig` tests (the latter prove the refactor is behavior-preserving).

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/enrichmentConfigService.ts backend/src/__tests__/enrichmentConfigService.test.ts
git commit -m "$(cat <<'EOF'
refactor(enrichment): extract processEnrichmentConfig from setEnrichmentConfig

Splits config processing (alias resolution, smart-field classification,
validation, audit stamping) from persistence so callers can process a
config in memory without writing it. setEnrichmentConfig now delegates.
EOF
)"
```

---

## Task 3: Create `enrichmentConfigDeps.ts` and wire `crm.ts` to it

**Files:**
- Create: `backend/src/services/enrichmentConfigDeps.ts`
- Modify: `backend/src/routes/crm.ts`

The real DDB + LLM dep implementations currently live inline in `crm.ts` (`crm.ts:71-173`). Move them into a shared module so Emma can build the same processing deps. This is a pure move — behavior is identical.

- [ ] **Step 1: Create the new file**

Create `backend/src/services/enrichmentConfigDeps.ts` with the content below. The bodies of `heuristicTypeSuggestion`, `llmInferAliases`, and `llmClassifySmartFields` are copied verbatim from `crm.ts:71-172`:

```typescript
// Real DynamoDB + LLM dependency implementations for the enrichment config
// service. Extracted from routes/crm.ts so both the CRM routes and Emma's
// enrichment tools build the deps the same way (DRY).

import { crmDb } from './db';
import type {
  ConfigServiceDeps,
  ConfigProcessingDeps,
  FieldTypeSuggestion,
} from './enrichmentConfigService';

function heuristicTypeSuggestion(
  fields: Array<{ name: string; instruction: string }>,
): FieldTypeSuggestion[] {
  return fields.map(({ name }) => {
    const lc = name.toLowerCase();
    if (/(_count|_at$|count$|number_of)/.test(lc) || lc === 'employees' || lc === 'revenue') {
      return { name, type: 'number' as const };
    }
    if (/^is_|^has_|verified$/.test(lc)) {
      return { name, type: 'boolean' as const };
    }
    if (lc.endsWith('_date') || lc.endsWith('date') || lc.endsWith('_at')) {
      return { name, type: 'date' as const };
    }
    return { name, type: 'string' as const };
  });
}

async function llmInferAliases(
  fields: Array<{ name: string; instruction: string }>,
): Promise<Record<string, string | null>> {
  if (fields.length === 0) return {};
  const { FIELD_GROUPS } = await import('./enrichmentGroups');
  const { createLLMService } = await import('../utils/llmService');

  const canonicalCheatsheet = Object.entries(FIELD_GROUPS)
    .map(([group, cfg]) => `  ${group}: ${cfg.fields.join(', ')}`)
    .join('\n');

  const systemPrompt =
    `You map user-named CRM enrichment fields to canonical field names ` +
    `based on semantic intent (not just name similarity). ` +
    `Return strict JSON keyed by user field name.\n\n` +
    `Available canonical fields, grouped:\n${canonicalCheatsheet}\n\n` +
    `Rules:\n` +
    `- Match by MEANING, not string similarity. "stag" with instruction ` +
    `"funding stage" → "funding_stage".\n` +
    `- Return null when the user's field is a unique custom concept (no ` +
    `confident canonical match).\n` +
    `- Use the field's instruction text to disambiguate. If instruction is ` +
    `empty, fall back to name alone.\n` +
    `- Pick at most ONE canonical name per user field.`;

  const userPrompt =
    `Map each user field to a canonical name (or null):\n` +
    fields.map(f => `- ${f.name}${f.instruction ? ` — "${f.instruction}"` : ''}`).join('\n') +
    `\n\nReturn JSON: {"<userFieldName>": "<canonical_name>" | null} for each input.`;

  try {
    const llm = createLLMService(
      process.env.CRM_ENRICH_V3_ALIAS_MODEL || 'gpt-5-chat-2',
      0.0,
    );
    const result = await llm.generateJSONContent<Record<string, string | null>>(
      systemPrompt,
      userPrompt,
    );
    return result ?? {};
  } catch (err) {
    console.warn('[enrichmentConfigDeps] llmInferAliases failed:', (err as Error).message);
    return {};
  }
}

async function llmClassifySmartFields(
  fields: Array<{ name: string; instruction: string }>,
): Promise<Record<string, any>> {
  if (fields.length === 0) return {};
  const { FIELD_GROUPS } = await import('./enrichmentGroups');
  const { createLLMService: mkLLM } = await import('../utils/llmService');
  const {
    buildSmartFieldClassificationSystemPrompt,
    buildSmartFieldClassificationUserPrompt,
  } = await import('./enrichmentPrompts');

  const canonicalFieldList = Object.entries(FIELD_GROUPS)
    .map(([group, cfg]) => `  ${group}: ${cfg.fields.join(', ')}`)
    .join('\n');

  try {
    const llm = mkLLM(process.env.CRM_ENRICH_V3_CLASSIFY_MODEL || process.env.CRM_ENRICH_V3_ALIAS_MODEL || 'gpt-5-chat-2', 0.0);
    const result = await llm.generateJSONContent<
      Record<string, { isSmartField: boolean; dependencies: string[]; fieldType?: 'string' | 'number' | 'boolean' | 'date' | 'enum'; enumOptions?: string[] }>
    >(
      buildSmartFieldClassificationSystemPrompt(canonicalFieldList),
      buildSmartFieldClassificationUserPrompt(fields),
    );
    return result ?? {};
  } catch (err) {
    console.warn('[enrichmentConfigDeps] llmClassifySmartFields failed:', (err as Error).message);
    return {};
  }
}

/** Full ConfigServiceDeps — read + write + LLM. Used by the CRM config routes. */
export function buildConfigServiceDeps(): ConfigServiceDeps {
  return {
    readListConfig: (listId) => crmDb.getEnrichmentConfig(listId),
    writeListConfig: (listId, config) => crmDb.setEnrichmentConfig(listId, config),
    loadListFieldNames: async (listId) => {
      const list = await crmDb.getLeadListById(listId);
      return Array.isArray(list?.fieldNames) ? (list!.fieldNames as string[]) : [];
    },
    llmSuggestTypes: async (fields) => heuristicTypeSuggestion(fields),
    llmInferAliases,
    llmClassifySmartFields,
  };
}

/** Processing-only deps — no writeListConfig. Used by Emma's in-memory path. */
export function buildConfigProcessingDeps(): ConfigProcessingDeps {
  return { readListConfig: (listId) => crmDb.getEnrichmentConfig(listId), llmInferAliases, llmClassifySmartFields };
}
```

- [ ] **Step 2: Run `npx tsc`**

Run: `cd backend && npx tsc`
Expected: no errors.

- [ ] **Step 3: Rewire `crm.ts` to use the new module**

In `backend/src/routes/crm.ts`:

1. Delete the `heuristicTypeSuggestion` function (`crm.ts:71-87`) and the entire `const enrichmentConfigDeps: ConfigServiceDeps = { ... };` object literal (`crm.ts:89-173`).
2. In their place put:

```typescript
import { buildConfigServiceDeps } from '../services/enrichmentConfigDeps';

const enrichmentConfigDeps = buildConfigServiceDeps();
```

3. The existing import block at `crm.ts:53-59` imports `type ConfigServiceDeps` and `type FieldTypeSuggestion` from `enrichmentConfigService`. If `ConfigServiceDeps` / `FieldTypeSuggestion` are no longer referenced anywhere else in `crm.ts` after the deletion, remove them from that import to avoid an unused-import error. Keep `svcGetEnrichmentConfig`, `svcSetEnrichmentConfig`, `svcSuggestFieldTypes`.

- [ ] **Step 4: Run `npx tsc`**

Run: `cd backend && npx tsc`
Expected: no errors. If TypeScript flags an unused import, remove it.

- [ ] **Step 5: Run the CRM route + config tests**

Run: `cd backend && npx jest src/__tests__/enrichmentConfigService.test.ts src/__tests__/crm.routes.test.ts src/__tests__/enrichmentConfigService.test.ts`
Expected: PASS — the move is behavior-preserving.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/enrichmentConfigDeps.ts backend/src/routes/crm.ts
git commit -m "$(cat <<'EOF'
refactor(enrichment): extract config-service deps into enrichmentConfigDeps

Moves the real DDB + LLM dep implementations out of routes/crm.ts into a
shared module so Emma's enrichment tools can build the same processing
deps. Adds buildConfigProcessingDeps() for the write-free in-memory path.
EOF
)"
```

---

## Task 4: Create `enrichmentToolConfig.ts` — the pure mapper

**Files:**
- Create: `backend/src/emma/enrichmentToolConfig.ts`
- Test: `backend/src/__tests__/enrichmentToolConfig.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `backend/src/__tests__/enrichmentToolConfig.test.ts`:

```typescript
import {
  buildRawEnrichmentConfig,
  getEmmaEnrichMaxLeads,
} from '../emma/enrichmentToolConfig';

describe('buildRawEnrichmentConfig', () => {
  it('throws when output_fields is empty', () => {
    expect(() => buildRawEnrichmentConfig([], 'user-1')).toThrow(/non-empty/);
  });

  it('throws when a field is missing a name', () => {
    expect(() =>
      buildRawEnrichmentConfig([{ name: '', instruction: 'find it' } as any], 'user-1'),
    ).toThrow(/name is required/);
  });

  it('throws when a field is missing an instruction', () => {
    expect(() =>
      buildRawEnrichmentConfig([{ name: 'industry', instruction: '' } as any], 'user-1'),
    ).toThrow(/instruction is required/);
  });

  it('maps a single field with default overwrite policy', () => {
    const cfg = buildRawEnrichmentConfig(
      [{ name: 'industry', instruction: 'classify their industry' }],
      'user-7',
    );
    expect(cfg.schemaVersion).toBe(1);
    expect(cfg.globalOverwriteDefault).toBe('fill_if_empty');
    expect(cfg.updatedBy).toBe('user-7');
    expect(cfg.fields).toHaveLength(1);
    expect(cfg.fields[0]).toMatchObject({
      name: 'industry',
      type: 'string',
      instruction: 'classify their industry',
      include: true,
      overwritePolicy: 'fill_if_empty',
    });
  });

  it('honors an explicit always_overwrite policy per field', () => {
    const cfg = buildRawEnrichmentConfig(
      [
        { name: 'a', instruction: 'x', overwrite_policy: 'always_overwrite' },
        { name: 'b', instruction: 'y' },
      ],
      'user-1',
    );
    expect(cfg.fields[0].overwritePolicy).toBe('always_overwrite');
    expect(cfg.fields[1].overwritePolicy).toBe('fill_if_empty');
  });

  it('trims whitespace from name and instruction', () => {
    const cfg = buildRawEnrichmentConfig(
      [{ name: '  industry  ', instruction: '  find it  ' }],
      'user-1',
    );
    expect(cfg.fields[0].name).toBe('industry');
    expect(cfg.fields[0].instruction).toBe('find it');
  });
});

describe('getEmmaEnrichMaxLeads', () => {
  const original = process.env.EMMA_ENRICH_MAX_LEADS;
  afterEach(() => {
    if (original === undefined) delete process.env.EMMA_ENRICH_MAX_LEADS;
    else process.env.EMMA_ENRICH_MAX_LEADS = original;
  });

  it('defaults to 500 when the env var is unset', () => {
    delete process.env.EMMA_ENRICH_MAX_LEADS;
    expect(getEmmaEnrichMaxLeads()).toBe(500);
  });

  it('reads a positive integer from the env var', () => {
    process.env.EMMA_ENRICH_MAX_LEADS = '25';
    expect(getEmmaEnrichMaxLeads()).toBe(25);
  });

  it('falls back to 500 for a non-numeric or non-positive value', () => {
    process.env.EMMA_ENRICH_MAX_LEADS = 'abc';
    expect(getEmmaEnrichMaxLeads()).toBe(500);
    process.env.EMMA_ENRICH_MAX_LEADS = '0';
    expect(getEmmaEnrichMaxLeads()).toBe(500);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest src/__tests__/enrichmentToolConfig.test.ts`
Expected: FAIL — module `../emma/enrichmentToolConfig` does not exist.

- [ ] **Step 3: Create the implementation**

Create `backend/src/emma/enrichmentToolConfig.ts`:

```typescript
// Pure mapping from Emma enrichment tool arguments to a V3 EnrichmentConfig,
// plus the Emma-side batch cap. No I/O — fully unit-testable.

import type { EnrichmentConfig, EnrichmentFieldConfig } from '../services/crmEnrichmentServiceV3';

/** One requested output field in an Emma enrichment tool call. */
export interface EmmaEnrichmentOutputField {
  name: string;
  instruction: string;
  overwrite_policy?: 'fill_if_empty' | 'always_overwrite';
}

/** Max leads a single enrich_leads_execute call may process. Env-tunable so
 *  it can be adjusted (e.g. lowered on the test env) without a deploy. */
export function getEmmaEnrichMaxLeads(): number {
  const raw = Number(process.env.EMMA_ENRICH_MAX_LEADS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 500;
}

/** Build a raw (unprocessed) V3 EnrichmentConfig from Emma tool args. The
 *  result still needs processEnrichmentConfig() before it can route through
 *  Apollo / smart fields. Throws on invalid input so the tool returns a
 *  clear error to Emma. */
export function buildRawEnrichmentConfig(
  outputFields: EmmaEnrichmentOutputField[],
  userId: string,
): EnrichmentConfig {
  if (!Array.isArray(outputFields) || outputFields.length === 0) {
    throw new Error('output_fields must be a non-empty array');
  }
  const fields: EnrichmentFieldConfig[] = outputFields.map((f, i) => {
    const name = typeof f?.name === 'string' ? f.name.trim() : '';
    const instruction = typeof f?.instruction === 'string' ? f.instruction.trim() : '';
    if (!name) throw new Error(`output_fields[${i}].name is required`);
    if (!instruction) throw new Error(`output_fields[${i}].instruction is required`);
    const overwritePolicy: 'fill_if_empty' | 'always_overwrite' =
      f.overwrite_policy === 'always_overwrite' ? 'always_overwrite' : 'fill_if_empty';
    return { name, type: 'string', instruction, include: true, overwritePolicy };
  });
  return {
    fields,
    globalOverwriteDefault: 'fill_if_empty',
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: userId,
  };
}
```

- [ ] **Step 4: Run `npx tsc` and the tests**

Run: `cd backend && npx tsc && npx jest src/__tests__/enrichmentToolConfig.test.ts`
Expected: `npx tsc` clean; all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/emma/enrichmentToolConfig.ts backend/src/__tests__/enrichmentToolConfig.test.ts
git commit -m "$(cat <<'EOF'
feat(emma): add enrichmentToolConfig — tool-args to V3 config mapper

Pure buildRawEnrichmentConfig() maps Emma's output_fields to a V3
EnrichmentConfig; getEmmaEnrichMaxLeads() exposes the env-tunable batch cap.
EOF
)"
```

---

## Task 5: Create `enrichmentToolRunner.ts` — process + run + map

**Files:**
- Create: `backend/src/emma/enrichmentToolRunner.ts`
- Test: `backend/src/__tests__/enrichmentToolRunner.test.ts`

This module: (a) `runEmmaEnrichment` — processes the config, calls V3 `runEnrichment`, maps the result to an Emma-friendly summary, and logs an engine-tagged line; (b) `pickPreviewLeadIds` — selects 2 representative sample leads; (c) `resolveExecuteLeadIds` — resolves the lead set and count for the cap check.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/__tests__/enrichmentToolRunner.test.ts`:

```typescript
jest.mock('../services/enrichmentConfigService', () => ({
  processEnrichmentConfig: jest.fn(),
}));
jest.mock('../services/enrichmentConfigDeps', () => ({
  buildConfigProcessingDeps: jest.fn().mockReturnValue({}),
}));
jest.mock('../services/crmEnrichmentServiceV3', () => ({
  runEnrichment: jest.fn(),
}));
jest.mock('../services/enrichmentV3RealDeps', () => ({
  buildOrchestratorDeps: jest.fn().mockReturnValue({}),
}));
jest.mock('../services/db', () => ({
  crmDb: { getLeadsByListId: jest.fn() },
}));

import { processEnrichmentConfig } from '../services/enrichmentConfigService';
import { runEnrichment } from '../services/crmEnrichmentServiceV3';
import { crmDb } from '../services/db';
import {
  runEmmaEnrichment,
  pickPreviewLeadIds,
  resolveExecuteLeadIds,
} from '../emma/enrichmentToolRunner';

const PROCESSED_CONFIG = {
  fields: [{ name: 'industry', type: 'string', instruction: 'x', include: true, overwritePolicy: 'fill_if_empty' }],
  globalOverwriteDefault: 'fill_if_empty',
  schemaVersion: 1,
  updatedAt: '2026-05-21T00:00:00.000Z',
  updatedBy: 'user-1',
};

beforeEach(() => {
  jest.clearAllMocks();
  (processEnrichmentConfig as jest.Mock).mockResolvedValue({ config: PROCESSED_CONFIG, warnings: [] });
});

describe('runEmmaEnrichment', () => {
  it('processes the config, runs V3 in enrich mode, and maps the summary', async () => {
    (runEnrichment as jest.Mock).mockResolvedValue({
      runId: 'run-1',
      processed: 8,
      failed: { identityResolutionFailed: 1, apolloFailed: 0, llmOrParseFailed: 1, updateFailed: 0, searchWebFailed: 0 },
      tierFillBreakdown: {},
      durationMs: 1234,
    });
    const summary = await runEmmaEnrichment({
      listId: 'list-1',
      userId: 'user-1',
      outputFields: [{ name: 'industry', instruction: 'classify industry' }],
      mode: 'enrich',
      leadIds: ['l1', 'l2'],
    });
    expect(processEnrichmentConfig).toHaveBeenCalled();
    expect(runEnrichment).toHaveBeenCalledWith(
      expect.objectContaining({ listId: 'list-1', userId: 'user-1', mode: 'enrich', leadIds: ['l1', 'l2'], config: PROCESSED_CONFIG }),
      expect.anything(),
      expect.objectContaining({ userId: 'user-1' }),
    );
    expect(summary).toMatchObject({
      runId: 'run-1',
      mode: 'enrich',
      processedCount: 8,
      failedCount: 2,
      durationMs: 1234,
      warnings: [],
    });
    expect(summary.samples).toBeUndefined();
  });

  it('maps preview samples from result.preview', async () => {
    (runEnrichment as jest.Mock).mockResolvedValue({
      runId: 'run-2',
      processed: 2,
      failed: { identityResolutionFailed: 0, apolloFailed: 0, llmOrParseFailed: 0, updateFailed: 0, searchWebFailed: 0 },
      tierFillBreakdown: {},
      durationMs: 50,
      preview: [
        { leadId: 'l1', extractedFields: { industry: 'Tech' }, meta: {} },
        { leadId: 'l2', extractedFields: { industry: 'Finance' }, meta: {} },
      ],
    });
    const summary = await runEmmaEnrichment({
      listId: 'list-1',
      userId: 'user-1',
      outputFields: [{ name: 'industry', instruction: 'classify industry' }],
      mode: 'preview',
      leadIds: ['l1', 'l2'],
    });
    expect(summary.mode).toBe('preview');
    expect(summary.samples).toEqual([
      { leadId: 'l1', enrichedFields: { industry: 'Tech' } },
      { leadId: 'l2', enrichedFields: { industry: 'Finance' } },
    ]);
  });

  it('surfaces config-processing warnings', async () => {
    (processEnrichmentConfig as jest.Mock).mockResolvedValue({
      config: PROCESSED_CONFIG,
      warnings: ["'company' and 'company_name'"],
    });
    (runEnrichment as jest.Mock).mockResolvedValue({
      runId: 'r', processed: 1,
      failed: { identityResolutionFailed: 0, apolloFailed: 0, llmOrParseFailed: 0, updateFailed: 0, searchWebFailed: 0 },
      tierFillBreakdown: {}, durationMs: 1,
    });
    const summary = await runEmmaEnrichment({
      listId: 'list-1', userId: 'user-1',
      outputFields: [{ name: 'industry', instruction: 'x' }], mode: 'enrich',
    });
    expect(summary.warnings).toEqual(["'company' and 'company_name'"]);
  });

  it('propagates a ConfigValidationError from processEnrichmentConfig', async () => {
    const err = new Error("'industry' is already in the list.");
    err.name = 'ConfigValidationError';
    (processEnrichmentConfig as jest.Mock).mockRejectedValue(err);
    await expect(
      runEmmaEnrichment({
        listId: 'list-1', userId: 'user-1',
        outputFields: [{ name: 'industry', instruction: 'x' }], mode: 'enrich',
      }),
    ).rejects.toThrow(/already in the list/);
    expect(runEnrichment).not.toHaveBeenCalled();
  });
});

describe('pickPreviewLeadIds', () => {
  it('prefers leads with identity data', async () => {
    (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
      items: [
        { leadId: 'a', email: '', linkedin: '' },
        { leadId: 'b', email: 'b@co.com', linkedin: '' },
        { leadId: 'c', email: '', linkedin: 'https://linkedin.com/in/c' },
        { leadId: 'd', email: '', linkedin: '' },
      ],
    });
    const ids = await pickPreviewLeadIds('list-1', undefined);
    expect(ids).toEqual(['b', 'c']);
  });

  it('falls back to the first leads when fewer than 2 have identity data', async () => {
    (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
      items: [{ leadId: 'a', email: '', linkedin: '' }, { leadId: 'b', email: '', linkedin: '' }],
    });
    const ids = await pickPreviewLeadIds('list-1', undefined);
    expect(ids).toEqual(['a', 'b']);
  });

  it('draws the sample from explicit lead_ids when provided', async () => {
    (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
      items: [
        { leadId: 'a', email: 'a@co.com' },
        { leadId: 'b', email: 'b@co.com' },
        { leadId: 'c', email: 'c@co.com' },
      ],
    });
    const ids = await pickPreviewLeadIds('list-1', ['c', 'a']);
    expect(ids.sort()).toEqual(['a', 'c']);
  });

  it('throws when the list has no leads', async () => {
    (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({ items: [] });
    await expect(pickPreviewLeadIds('list-1', undefined)).rejects.toThrow(/no leads/i);
  });
});

describe('resolveExecuteLeadIds', () => {
  it('uses explicit lead_ids and their count', async () => {
    const r = await resolveExecuteLeadIds('list-1', ['x', 'y', 'z']);
    expect(r).toEqual({ leadIds: ['x', 'y', 'z'], count: 3 });
    expect(crmDb.getLeadsByListId).not.toHaveBeenCalled();
  });

  it('counts the whole list when lead_ids is absent', async () => {
    (crmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
      items: [{ leadId: 'a' }, { leadId: 'b' }],
    });
    const r = await resolveExecuteLeadIds('list-1', undefined);
    expect(r).toEqual({ leadIds: undefined, count: 2 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest src/__tests__/enrichmentToolRunner.test.ts`
Expected: FAIL — module `../emma/enrichmentToolRunner` does not exist.

- [ ] **Step 3: Create the implementation**

Create `backend/src/emma/enrichmentToolRunner.ts`:

```typescript
// Emma enrichment runner: builds + processes a V3 config, runs the V3
// engine, and maps the result to an Emma-friendly summary. Also provides
// lead-set helpers (preview sampling, execute cap resolution).

import { processEnrichmentConfig } from '../services/enrichmentConfigService';
import { buildConfigProcessingDeps } from '../services/enrichmentConfigDeps';
import { runEnrichment, type RunEnrichmentResult } from '../services/crmEnrichmentServiceV3';
import { buildOrchestratorDeps } from '../services/enrichmentV3RealDeps';
import type { SocketEmitFn } from '../services/crmEnrichmentService';
import { buildRawEnrichmentConfig, type EmmaEnrichmentOutputField } from './enrichmentToolConfig';

/** Emma-facing summary of a V3 enrichment run. */
export interface EmmaEnrichmentSummary {
  runId: string;
  mode: 'preview' | 'enrich';
  processedCount: number;
  failedCount: number;
  failureBreakdown: RunEnrichmentResult['failed'];
  durationMs: number;
  warnings: string[];
  samples?: Array<{ leadId: string; enrichedFields: Record<string, string> }>;
}

export interface RunEmmaEnrichmentParams {
  listId: string;
  userId: string;
  outputFields: EmmaEnrichmentOutputField[];
  mode: 'preview' | 'enrich';
  leadIds?: string[];
  socketId?: string;
  socketEmit?: SocketEmitFn;
}

/**
 * Process an Emma enrichment request through the V3 engine. Builds the raw
 * config, processes it (alias resolution + smart-field classification +
 * validation — may throw ConfigValidationError), runs V3, and maps the
 * result. Logs one engine-tagged line per run for observability.
 */
export async function runEmmaEnrichment(
  params: RunEmmaEnrichmentParams,
): Promise<EmmaEnrichmentSummary> {
  const rawConfig = buildRawEnrichmentConfig(params.outputFields, params.userId);
  const { config, warnings } = await processEnrichmentConfig(
    { listId: params.listId, userId: params.userId, config: rawConfig },
    buildConfigProcessingDeps(),
  );

  const deps = buildOrchestratorDeps(params.userId);
  const result = await runEnrichment(
    {
      listId: params.listId,
      userId: params.userId,
      config,
      mode: params.mode,
      leadIds: params.leadIds,
    },
    deps,
    { userId: params.userId, socketId: params.socketId, socketEmit: params.socketEmit },
  );

  const failedCount = Object.values(result.failed).reduce((a, b) => a + b, 0);

  // Observability: engine-tagged line so we can confirm Emma traffic is on V3.
  console.log(
    `[emma-enrich] engine=v3 runId=${result.runId} listId=${params.listId} ` +
    `userId=${params.userId} mode=${params.mode} leads=${result.processed} ` +
    `fields=${params.outputFields.length} failed=${failedCount} durationMs=${result.durationMs}`,
  );

  const summary: EmmaEnrichmentSummary = {
    runId: result.runId,
    mode: params.mode,
    processedCount: result.processed,
    failedCount,
    failureBreakdown: result.failed,
    durationMs: result.durationMs,
    warnings,
  };
  if (params.mode === 'preview' && Array.isArray(result.preview)) {
    summary.samples = result.preview.map(p => ({
      leadId: p.leadId,
      enrichedFields: p.extractedFields,
    }));
  }
  return summary;
}

/** Select 2 representative sample leads for a preview run. Prefers leads
 *  with identity data (email or linkedin) so the preview shows useful
 *  results. Throws when the list has no leads to sample. */
export async function pickPreviewLeadIds(
  listId: string,
  explicitLeadIds: string[] | undefined,
): Promise<string[]> {
  const { crmDb } = await import('../services/db');
  const result = await crmDb.getLeadsByListId(listId);
  const items: any[] = Array.isArray(result?.items) ? result.items : [];
  const pool = explicitLeadIds && explicitLeadIds.length > 0
    ? items.filter(l => explicitLeadIds.includes(l.leadId))
    : items;
  if (pool.length === 0) {
    throw new Error('This list has no leads to preview enrichment on.');
  }
  const hasIdentity = (l: any) =>
    (typeof l.email === 'string' && l.email.trim()) ||
    (typeof l.linkedin === 'string' && l.linkedin.trim());
  const withIdentity = pool.filter(hasIdentity);
  const chosen = (withIdentity.length >= 2 ? withIdentity : pool).slice(0, 2);
  return chosen.map(l => l.leadId);
}

/** Resolve the lead set + count for an execute run. With explicit lead_ids,
 *  the count is their length. Otherwise the whole list is counted (and
 *  leadIds stays undefined so V3 queries the full list). */
export async function resolveExecuteLeadIds(
  listId: string,
  explicitLeadIds: string[] | undefined,
): Promise<{ leadIds: string[] | undefined; count: number }> {
  if (explicitLeadIds && explicitLeadIds.length > 0) {
    return { leadIds: explicitLeadIds, count: explicitLeadIds.length };
  }
  const { crmDb } = await import('../services/db');
  const result = await crmDb.getLeadsByListId(listId);
  const items: any[] = Array.isArray(result?.items) ? result.items : [];
  return { leadIds: undefined, count: items.length };
}
```

- [ ] **Step 4: Run `npx tsc` and the tests**

Run: `cd backend && npx tsc && npx jest src/__tests__/enrichmentToolRunner.test.ts`
Expected: `npx tsc` clean; all tests PASS.

Note: if `npx tsc` reports that `RunEnrichmentResult` is not exported from `crmEnrichmentServiceV3.ts`, it already is (`export interface RunEnrichmentResult` at `crmEnrichmentServiceV3.ts:117`) — re-check the import spelling.

- [ ] **Step 5: Commit**

```bash
git add backend/src/emma/enrichmentToolRunner.ts backend/src/__tests__/enrichmentToolRunner.test.ts
git commit -m "$(cat <<'EOF'
feat(emma): add enrichmentToolRunner — process + run V3 + map result

runEmmaEnrichment processes a config and runs the V3 engine, mapping the
result to an Emma summary with an engine-tagged log line. Adds preview
sampling and execute lead-set/cap resolution helpers.
EOF
)"
```

---

## Task 6: Rewrite `enrich_leads_preview` and `enrich_leads_execute`

**Files:**
- Modify: `backend/src/emma/tools.ts` (`tools.ts:5623-5819`)
- Test: `backend/src/__tests__/emma.enrichLeads.test.ts`

- [ ] **Step 1: Rewrite the test file (preview + execute sections)**

Replace the **entire** content of `backend/src/__tests__/emma.enrichLeads.test.ts` down to (but not including) the `describe('enrich_lead_custom tool', ...)` block with the content below. The `enrich_lead_custom` block is rewritten in Task 7 — leave a placeholder closing for now by ending the file after the execute tests; Task 7 re-adds the custom block.

```typescript
// Tests for Emma CRM enrichment tool registration and execution (V3 engine)

jest.mock('../server', () => ({
  io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() },
  app: {},
}));

jest.mock('../emma/enrichmentToolRunner', () => ({
  runEmmaEnrichment: jest.fn(),
  pickPreviewLeadIds: jest.fn(),
  resolveExecuteLeadIds: jest.fn(),
}));

jest.mock('../services/db', () => ({
  crmDb: { getLeadById: jest.fn() },
}));

import '../emma/tools';
import { emmaToolRegistry } from '../emma/registry';
import {
  runEmmaEnrichment,
  pickPreviewLeadIds,
  resolveExecuteLeadIds,
} from '../emma/enrichmentToolRunner';

const SUMMARY = {
  runId: 'run-1',
  mode: 'enrich' as const,
  processedCount: 5,
  failedCount: 0,
  failureBreakdown: { identityResolutionFailed: 0, apolloFailed: 0, llmOrParseFailed: 0, updateFailed: 0, searchWebFailed: 0 },
  durationMs: 100,
  warnings: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  (runEmmaEnrichment as jest.Mock).mockResolvedValue(SUMMARY);
  (pickPreviewLeadIds as jest.Mock).mockResolvedValue(['l1', 'l2']);
  (resolveExecuteLeadIds as jest.Mock).mockResolvedValue({ leadIds: undefined, count: 5 });
});

describe('enrich_leads_preview', () => {
  it('registers with the new object-array output_fields schema', () => {
    const tool = emmaToolRegistry.getTool('enrich_leads_preview')!;
    expect(tool).toBeDefined();
    expect(tool.definition.inputSchema.required).toEqual(
      expect.arrayContaining(['list_id', 'output_fields']),
    );
    expect(tool.definition.inputSchema.required).not.toContain('instruction');
    expect(tool.definition.inputSchema.required).not.toContain('sources');
  });

  it('runs V3 in preview mode on the sampled lead ids', async () => {
    const tool = emmaToolRegistry.getTool('enrich_leads_preview')!;
    const result = await tool.execute(
      { list_id: 'list-abc', output_fields: [{ name: 'industry', instruction: 'classify' }] },
      { userId: 'user1', socketId: 'sock-1' },
    );
    expect(pickPreviewLeadIds).toHaveBeenCalledWith('list-abc', undefined);
    expect(runEmmaEnrichment).toHaveBeenCalledWith(expect.objectContaining({
      listId: 'list-abc',
      userId: 'user1',
      mode: 'preview',
      leadIds: ['l1', 'l2'],
      socketId: 'sock-1',
    }));
    expect(result).toBe(SUMMARY);
  });

  it('rejects when there is no user context', async () => {
    const tool = emmaToolRegistry.getTool('enrich_leads_preview')!;
    await expect(
      tool.execute({ list_id: 'l', output_fields: [{ name: 'f', instruction: 'i' }] }, {}),
    ).rejects.toThrow(/Authentication required/);
  });
});

describe('enrich_leads_execute', () => {
  it('registers and requires list_id + output_fields', () => {
    const tool = emmaToolRegistry.getTool('enrich_leads_execute')!;
    expect(tool).toBeDefined();
    expect(tool.definition.inputSchema.required).toEqual(
      expect.arrayContaining(['list_id', 'output_fields']),
    );
  });

  it('runs V3 in enrich mode for a list under the cap', async () => {
    (resolveExecuteLeadIds as jest.Mock).mockResolvedValue({ leadIds: undefined, count: 5 });
    const tool = emmaToolRegistry.getTool('enrich_leads_execute')!;
    await tool.execute(
      { list_id: 'list-abc', output_fields: [{ name: 'industry', instruction: 'classify' }] },
      { userId: 'user1', socketId: 'sock-1' },
    );
    expect(runEmmaEnrichment).toHaveBeenCalledWith(expect.objectContaining({
      listId: 'list-abc', userId: 'user1', mode: 'enrich', leadIds: undefined,
    }));
  });

  it('passes an explicit lead_ids subset through', async () => {
    (resolveExecuteLeadIds as jest.Mock).mockResolvedValue({ leadIds: ['a', 'b'], count: 2 });
    const tool = emmaToolRegistry.getTool('enrich_leads_execute')!;
    await tool.execute(
      { list_id: 'list-abc', output_fields: [{ name: 'industry', instruction: 'classify' }], lead_ids: ['a', 'b'] },
      { userId: 'user1' },
    );
    expect(runEmmaEnrichment).toHaveBeenCalledWith(expect.objectContaining({ leadIds: ['a', 'b'] }));
  });

  it('rejects and does not run when the list exceeds the cap', async () => {
    process.env.EMMA_ENRICH_MAX_LEADS = '10';
    (resolveExecuteLeadIds as jest.Mock).mockResolvedValue({ leadIds: undefined, count: 11 });
    const tool = emmaToolRegistry.getTool('enrich_leads_execute')!;
    await expect(
      tool.execute(
        { list_id: 'big', output_fields: [{ name: 'industry', instruction: 'classify' }] },
        { userId: 'user1' },
      ),
    ).rejects.toThrow(/limit/i);
    expect(runEmmaEnrichment).not.toHaveBeenCalled();
    delete process.env.EMMA_ENRICH_MAX_LEADS;
  });

  it('rejects when the list is empty', async () => {
    (resolveExecuteLeadIds as jest.Mock).mockResolvedValue({ leadIds: undefined, count: 0 });
    const tool = emmaToolRegistry.getTool('enrich_leads_execute')!;
    await expect(
      tool.execute(
        { list_id: 'empty', output_fields: [{ name: 'industry', instruction: 'classify' }] },
        { userId: 'user1' },
      ),
    ).rejects.toThrow(/no leads/i);
    expect(runEmmaEnrichment).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest src/__tests__/emma.enrichLeads.test.ts`
Expected: FAIL — the tools still use the old schema/handlers.

- [ ] **Step 3: Rewrite the `enrich_leads_preview` registration**

In `backend/src/emma/tools.ts`, replace the entire `emmaToolRegistry.register({ name: 'enrich_leads_preview', ... })` block (`tools.ts:5623-5723`) with:

```typescript
emmaToolRegistry.register({
  name: 'enrich_leads_preview',
  definition: {
    name: 'enrich_leads_preview',
    description: `Preview a CRM lead enrichment job before running the full batch. Runs the V3 enrichment engine in preview mode on 2 sample leads and returns what it would produce.

Returns: runId, processedCount (the 2 sampled leads), and samples — each with leadId and enrichedFields. In enrichedFields a missing value means nothing was found; tell the user "not found" rather than showing null. Show the samples and ask the user to confirm before calling enrich_leads_execute.

output_fields guidance: one entry per distinct data point. Each entry has a snake_case "name", an "instruction" (what to find / where it lives), and an optional "overwrite_policy". Numeric values, categorical values, URLs, and prose summaries each get their own field. The engine routes data sources (Apollo, LinkedIn, web search) automatically — you do not specify sources.`,
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'The CRM lead list ID to enrich.' },
        output_fields: {
          type: 'array',
          minItems: 1,
          description: 'Fields to populate. One entry per distinct data point.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Custom field name in snake_case, e.g. "funding_stage".' },
              instruction: { type: 'string', description: 'Natural-language description of what to find for this field.' },
              overwrite_policy: {
                type: 'string',
                enum: ['fill_if_empty', 'always_overwrite'],
                description: 'fill_if_empty (default): only set the field when it is currently empty. always_overwrite: refresh even when a value already exists.',
              },
            },
            required: ['name', 'instruction'],
          },
        },
        lead_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional. When provided, the 2 preview samples are drawn from this subset.',
        },
      },
      required: ['list_id', 'output_fields'],
    },
  },
  execute: async (args: any, context: any) => {
    if (!context?.userId) {
      throw new Error('Authentication required: no user context');
    }
    const { runEmmaEnrichment, pickPreviewLeadIds } = await import('./enrichmentToolRunner');
    const leadIds = await pickPreviewLeadIds(args.list_id, args.lead_ids);
    return await runEmmaEnrichment({
      listId: args.list_id,
      userId: context.userId,
      outputFields: args.output_fields,
      mode: 'preview',
      leadIds,
      socketId: context.socketId,
      socketEmit: context.socketEmit,
    });
  },
});
```

- [ ] **Step 4: Rewrite the `enrich_leads_execute` registration**

Replace the entire `emmaToolRegistry.register({ name: 'enrich_leads_execute', ... })` block (`tools.ts:5725-5819`) with:

```typescript
emmaToolRegistry.register({
  name: 'enrich_leads_execute',
  definition: {
    name: 'enrich_leads_execute',
    description: `Execute a CRM lead enrichment job on the V3 engine. Processes the list's leads in parallel, enriching the requested fields from Apollo, LinkedIn, and web search automatically.

Progress updates stream via Socket.IO. This call blocks until the job completes, then returns runId, processedCount, failedCount, and failureBreakdown.

Call enrich_leads_preview first and let the user confirm. Pass the same output_fields used in the preview. Large lists are capped — if the list is over the limit, narrow it with lead_ids or tell the user to run a full enrichment from the CRM page.`,
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'The CRM lead list ID to enrich.' },
        output_fields: {
          type: 'array',
          minItems: 1,
          description: 'Fields to populate. One entry per distinct data point.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Custom field name in snake_case.' },
              instruction: { type: 'string', description: 'Natural-language description of what to find for this field.' },
              overwrite_policy: {
                type: 'string',
                enum: ['fill_if_empty', 'always_overwrite'],
                description: 'fill_if_empty (default): only set the field when empty. always_overwrite: refresh even when a value exists.',
              },
            },
            required: ['name', 'instruction'],
          },
        },
        lead_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional subset of lead IDs to enrich. Omit to enrich the whole list.',
        },
      },
      required: ['list_id', 'output_fields'],
    },
  },
  execute: async (args: any, context: any) => {
    if (!context?.userId) {
      throw new Error('Authentication required: no user context');
    }
    const { runEmmaEnrichment, resolveExecuteLeadIds } = await import('./enrichmentToolRunner');
    const { getEmmaEnrichMaxLeads } = await import('./enrichmentToolConfig');
    const { leadIds, count } = await resolveExecuteLeadIds(args.list_id, args.lead_ids);
    if (count === 0) {
      throw new Error('This list has no leads to enrich.');
    }
    const max = getEmmaEnrichMaxLeads();
    if (count > max) {
      throw new Error(
        `This run targets ${count} leads, over the ${max}-lead limit for enrichment through chat. ` +
        `Narrow it with lead_ids, or run a full enrichment from the CRM page's Enrichment Config.`,
      );
    }
    return await runEmmaEnrichment({
      listId: args.list_id,
      userId: context.userId,
      outputFields: args.output_fields,
      mode: 'enrich',
      leadIds,
      socketId: context.socketId,
      socketEmit: context.socketEmit,
    });
  },
});
```

- [ ] **Step 5: Run `npx tsc`**

Run: `cd backend && npx tsc`
Expected: no errors.

- [ ] **Step 6: Run the tests**

Run: `cd backend && npx jest src/__tests__/emma.enrichLeads.test.ts`
Expected: PASS for the `enrich_leads_preview` and `enrich_leads_execute` describe blocks. (The `enrich_lead_custom` block was removed in Step 1 and is restored in Task 7.)

- [ ] **Step 7: Commit**

```bash
git add backend/src/emma/tools.ts backend/src/__tests__/emma.enrichLeads.test.ts
git commit -m "$(cat <<'EOF'
feat(emma): migrate enrich_leads_preview/execute to the V3 engine

Both tools now build an in-memory V3 config, process it, and call
runEnrichment instead of the legacy CrmEnrichmentService. New object-array
output_fields schema with per-field overwrite_policy; enrich_leads_execute
enforces the EMMA_ENRICH_MAX_LEADS batch cap.
EOF
)"
```

---

## Task 7: Rewrite `enrich_lead_custom`

**Files:**
- Modify: `backend/src/emma/tools.ts` (`tools.ts:5821-5936`)
- Test: `backend/src/__tests__/emma.enrichLeads.test.ts`

- [ ] **Step 1: Append the failing tests**

Add this describe block to `backend/src/__tests__/emma.enrichLeads.test.ts`, before the file's final closing. It uses the `crmDb.getLeadById` mock already declared at the top of the file:

```typescript
import { crmDb } from '../services/db';

describe('enrich_lead_custom', () => {
  beforeEach(() => {
    (crmDb.getLeadById as jest.Mock).mockResolvedValue({
      leadId: 'lead-7',
      customFields: { company_size: '200' },
      title: 'CTO',
    });
  });

  it('registers and requires list_id + lead_id + output_fields', () => {
    const tool = emmaToolRegistry.getTool('enrich_lead_custom')!;
    expect(tool).toBeDefined();
    expect(tool.definition.inputSchema.required).toEqual(
      expect.arrayContaining(['list_id', 'lead_id', 'output_fields']),
    );
  });

  it('runs V3 enrich mode on a single-lead batch and returns enriched values', async () => {
    (runEmmaEnrichment as jest.Mock).mockResolvedValue({ ...SUMMARY, processedCount: 1 });
    const tool = emmaToolRegistry.getTool('enrich_lead_custom')!;
    const result = await tool.execute(
      {
        list_id: 'list-abc',
        lead_id: 'lead-7',
        output_fields: [
          { name: 'company_size', instruction: 'find headcount' },
          { name: 'title', instruction: 'find their job title' },
        ],
      },
      { userId: 'user1' },
    );
    expect(runEmmaEnrichment).toHaveBeenCalledWith(expect.objectContaining({
      listId: 'list-abc',
      userId: 'user1',
      mode: 'enrich',
      leadIds: ['lead-7'],
    }));
    expect(result.leadId).toBe('lead-7');
    expect(result.enrichedValues).toEqual({ company_size: '200', title: 'CTO' });
  });

  it('rejects when output_fields is empty (via buildRawEnrichmentConfig)', async () => {
    (runEmmaEnrichment as jest.Mock).mockRejectedValue(new Error('output_fields must be a non-empty array'));
    const tool = emmaToolRegistry.getTool('enrich_lead_custom')!;
    await expect(
      tool.execute({ list_id: 'l', lead_id: 'x', output_fields: [] }, { userId: 'user1' }),
    ).rejects.toThrow(/non-empty/);
  });

  it('rejects when there is no user context', async () => {
    const tool = emmaToolRegistry.getTool('enrich_lead_custom')!;
    await expect(
      tool.execute(
        { list_id: 'l', lead_id: 'x', output_fields: [{ name: 'f', instruction: 'i' }] },
        {},
      ),
    ).rejects.toThrow(/Authentication required/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest src/__tests__/emma.enrichLeads.test.ts -t enrich_lead_custom`
Expected: FAIL — the tool still uses the old `custom_field_prompts` schema and legacy service.

- [ ] **Step 3: Rewrite the `enrich_lead_custom` registration**

In `backend/src/emma/tools.ts`, replace the entire `emmaToolRegistry.register({ name: 'enrich_lead_custom', ... })` block (`tools.ts:5821-5936`) with:

```typescript
emmaToolRegistry.register({
  name: 'enrich_lead_custom',
  definition: {
    name: 'enrich_lead_custom',
    description: `Enrich a single CRM lead with custom fields on demand, without running a whole-list job.

Use this when the user wants specific missing information filled on one lead (e.g. "find this person's LinkedIn headline and company size"). It runs the V3 enrichment engine on a batch of one. The response includes enrichedValues — a map of field name to the found value (null if nothing was found). Values are also persisted to the lead. Always show enrichedValues to the user; if a value is null, say nothing was found for that field.

output_fields: one entry per field to populate, each with a snake_case "name", an "instruction" describing what to find, and an optional "overwrite_policy" (defaults to fill_if_empty; use always_overwrite to refresh a field that already has a value).`,
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'The CRM lead list ID containing the lead.' },
        lead_id: { type: 'string', description: 'The specific lead to enrich.' },
        output_fields: {
          type: 'array',
          minItems: 1,
          description: 'Fields to populate on this lead.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Custom field name in snake_case.' },
              instruction: { type: 'string', description: 'Natural-language description of what to find for this field.' },
              overwrite_policy: {
                type: 'string',
                enum: ['fill_if_empty', 'always_overwrite'],
                description: 'fill_if_empty (default): only set the field when empty. always_overwrite: refresh even when a value exists.',
              },
            },
            required: ['name', 'instruction'],
          },
        },
      },
      required: ['list_id', 'lead_id', 'output_fields'],
    },
  },
  execute: async (args: any, context: any) => {
    if (!context?.userId) {
      throw new Error('Authentication required: no user context');
    }
    const { runEmmaEnrichment } = await import('./enrichmentToolRunner');
    const summary = await runEmmaEnrichment({
      listId: args.list_id,
      userId: context.userId,
      outputFields: args.output_fields,
      mode: 'enrich',
      leadIds: [args.lead_id],
      socketId: context.socketId,
      socketEmit: context.socketEmit,
    });

    // Read the lead back so we can return the actual enriched values.
    // V3 writes standard columns top-level and custom names into customFields.
    const enrichedValues: Record<string, string | null> = {};
    if (summary.processedCount > 0) {
      try {
        const { crmDb } = await import('../services/db');
        const lead: any = await crmDb.getLeadById(args.list_id, args.lead_id);
        const customFields = (lead?.customFields ?? {}) as Record<string, string>;
        for (const f of (args.output_fields as Array<{ name: string }>)) {
          enrichedValues[f.name] = customFields[f.name] ?? lead?.[f.name] ?? null;
        }
      } catch {
        // Non-fatal — enrichment succeeded, values are in the DB.
      }
    }

    return {
      leadId: args.lead_id,
      listId: args.list_id,
      enrichedValues,
      runId: summary.runId,
      processedCount: summary.processedCount,
      failedCount: summary.failedCount,
      failureBreakdown: summary.failureBreakdown,
      warnings: summary.warnings,
    };
  },
});
```

- [ ] **Step 4: Run `npx tsc` and the tests**

Run: `cd backend && npx tsc && npx jest src/__tests__/emma.enrichLeads.test.ts`
Expected: `npx tsc` clean; the full `emma.enrichLeads.test.ts` file PASSES (preview, execute, custom).

- [ ] **Step 5: Commit**

```bash
git add backend/src/emma/tools.ts backend/src/__tests__/emma.enrichLeads.test.ts
git commit -m "$(cat <<'EOF'
feat(emma): migrate enrich_lead_custom to the V3 engine

Single-lead enrichment now runs the V3 engine via runEmmaEnrichment with a
one-lead batch. Unifies the input on the output_fields schema and reads the
lead back to return enrichedValues.
EOF
)"
```

---

## Task 8: Full backend verification

No new code — this is the gate before E2E.

- [ ] **Step 1: TypeScript compilation**

Run: `cd backend && npx tsc`
Expected: no errors.

- [ ] **Step 2: Full test suite**

Run: `cd backend && npm test`
Expected: all tests PASS. Investigate and fix any failure before continuing — pay attention to other suites that import `crm.ts` or `enrichmentConfigService.ts`.

- [ ] **Step 3: Coverage gate**

Run: `cd backend && npm run test:coverage -- --coverageReporters=text --coverageReporters=json-summary`
Expected: ≥95% on statements, branches, functions, and lines. If a new file is under 95%, add the missing-branch test to the matching `*.test.ts` (the most likely gaps: the `pickPreviewLeadIds` fallback branch and the `getEmmaEnrichMaxLeads` non-numeric branch — both already covered above; verify) and re-run.

- [ ] **Step 4: Commit (only if coverage tests were added)**

```bash
git add backend/src/__tests__/
git commit -m "$(cat <<'EOF'
test(emma): cover remaining branches for V3 enrichment migration
EOF
)"
```

---

## Task 9: Add the user-facing release note

**Files:**
- Modify: `backend/src/docs/user-release.ts`

- [ ] **Step 1: Add the release entry**

Open `backend/src/docs/user-release.ts`. Following the existing entry format in that file, add a `2026-05-21` entry. Match the surrounding structure exactly (same object/array shape, field names, and ordering as the most recent entries). The content:

- **Title:** `Fixed: Lead Enrichment via Emma Now Fills Every Requested Field`
- **Body:** Asking Emma to enrich CRM leads now uses the same enrichment engine as the CRM page's Enrichment Config. Previously some requested fields (LinkedIn summary, skills, headline, location, and others) could come back empty even though the job reported success. Emma enrichment now also benefits from Apollo and LinkedIn structured-data lookups and the accuracy safeguards already used by the CRM page.

- [ ] **Step 2: Run `npx tsc`**

Run: `cd backend && npx tsc`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/docs/user-release.ts
git commit -m "$(cat <<'EOF'
docs: add 2026-05-21 release note for Emma enrichment V3 migration
EOF
)"
```

---

## Task 10: Cloud test environment — launch and seed

This begins the E2E phase. All E2E cases run against the cloud test environment and use the Playwright MCP tools (`mcp__playwright__browser_*`).

- [ ] **Step 1: Launch the test environment**

Run: `./test-env/test-env.sh launch`
Then: `./test-env/test-env.sh sync`
Expected: the script prints the test environment URL. Record it as `<TEST_URL>`. See `docs/cloud-test-env.md` if the launch needs setup.

- [ ] **Step 2: Lower the cap on the test env**

So the cap case (F8) can use a small list, set `EMMA_ENRICH_MAX_LEADS` low on the test environment's backend (e.g. `5`). Use the test-env mechanism for backend env vars documented in `docs/cloud-test-env.md`; if env-var injection is not available, instead seed List B (below) with just over 500 leads. Record the effective cap as `<CAP>`.

- [ ] **Step 3: Log in and seed CRM data**

Using the Playwright MCP tools, navigate to `<TEST_URL>`, log in as `test@example.com` / `Test123!`, and open the CRM page. Create three lead lists:
- **List A** — import ~6 leads. At least 2 must have both a work `email` and a `linkedin` URL; include 1 lead with only a name and company (sparse). Use real-looking companies so web/Apollo lookups have something to find.
- **List B** — a list with more than `<CAP>` leads (e.g. `<CAP>` + 3 minimal rows).
- **List C** — any small list; then open **Enrichment Config**, add and **Save** a config with one field (e.g. `industry`). This persisted config is the baseline for the non-clobber check (F11).

Record the list IDs as `<LIST_A>`, `<LIST_B>`, `<LIST_C>`.

- [ ] **Step 4: Note re-sync requirement**

Reminder for the executor: after **every** backend code change during E2E debugging, re-run `./test-env/test-env.sh sync` before re-testing. No commit for this task.

---

## Task 11: E2E test matrix — execute every case

Each step drives Emma in the customer-portal chat against `<TEST_URL>` via the Playwright MCP tools, and verifies the result in the CRM grid, the backend logs, or the `AW-EnrichmentJobs` / `AW-Leads` DynamoDB tables. For each case: establish the pre-state, send the prompt to Emma, wait for completion, then assert. If a case fails, stop, diagnose, fix, re-`sync`, and re-run that case.

- [ ] **Case 1 — Preview happy path.** Open Emma, ask: "Preview enrichment of list `<LIST_A>` for two custom fields: company_industry and company_employee_count." Assert: Emma calls `enrich_leads_preview`; the response shows sample values for exactly 2 leads; the CRM grid for `<LIST_A>` is unchanged (no values written).

- [ ] **Case 2 — Execute, standard fields.** Ask Emma to enrich `title` and `company` on `<LIST_A>` and confirm when prompted. Assert: the run completes with `failedCount` 0; the CRM grid shows populated `title` / `company` values.

- [ ] **Case 3 — Execute, extended fields (the regression).** Ask Emma to enrich `summary`, `skills`, `headline`, and `location` on the 2 identity-rich leads of `<LIST_A>` (pass them as a subset). After completion, open those leads. Assert: the four fields are **non-empty**. This is the core proof the bug is fixed — before the migration these came back empty.

- [ ] **Case 4 — Apollo-routed field quality.** Ask Emma to enrich `tech_stack` (or `annual_revenue`) on a lead in `<LIST_A>` whose company is well-known. Assert: the value populates; open the field's enrichment metadata (hover/inspect in the grid, or query `AW-Leads` `enrichmentMetadata`) and confirm the source is Apollo, not a web-only guess — proving config processing resolved `aliasFor`.

- [ ] **Case 5 — Per-field overwrite policy.** Pick a lead with an existing `company_industry` value. Ask Emma to enrich two fields: `company_industry` with `fill_if_empty` and `company_employee_count` with `always_overwrite`. Assert: `company_industry` keeps its original value; `company_employee_count` is (re)written.

- [ ] **Case 6 — Subset via lead_ids.** Ask Emma to enrich one named field on only 2 specific leads of `<LIST_A>`. Assert: exactly those 2 leads change; the other leads are untouched.

- [ ] **Case 7 — Single-lead enrichment.** Ask Emma to "enrich the LinkedIn headline for <one named lead>" in `<LIST_A>`. Assert: Emma calls `enrich_lead_custom`; that one lead's field populates; no other lead changes; the response includes `enrichedValues`.

- [ ] **Case 8 — Cap enforcement.** Ask Emma to enrich any field on `<LIST_B>` (over `<CAP>`). Assert: Emma's response contains the cap error mentioning the limit and suggesting `lead_ids` / the CRM page; no enrichment runs; the `<LIST_B>` grid is unchanged; no new `AW-EnrichmentJobs` record for this attempt.

- [ ] **Case 9 — Config validation error.** Ask Emma to enrich `<LIST_A>` with two output fields that have the **same name**. Assert: Emma surfaces a clear "already in the list" validation error and does not run. Repeat asking for a field literally named `leadId`. Assert: a clear "reserved" error, no run.

- [ ] **Case 10 — Config-processing warnings.** Ask Emma to enrich `<LIST_A>` with two fields that route to the same canonical name (e.g. `company` and `company_name`). Assert: the run completes; Emma's response surfaces the route-collision warning.

- [ ] **Case 11 — UI config not clobbered.** Note `<LIST_C>`'s saved Enrichment Config (the `industry` field). Ask Emma to enrich `<LIST_C>` with a different field (e.g. `funding_stage`). After completion, reopen the Enrichment Config dialog for `<LIST_C>`. Assert: the saved config still shows exactly the original `industry` field — Emma did not overwrite it.

- [ ] **Case 12 — New field column auto-registers.** Ask Emma to enrich `<LIST_A>` with a brand-new custom field name (e.g. `product_certifications`). After completion, open "Configure Display Fields" for `<LIST_A>`. Assert: `product_certifications` appears as a selectable column.

- [ ] **Case 13 — Progress updates.** Start an Emma execute run on `<LIST_A>` from the CRM page. While it runs, observe the CRM page. Assert: the enrichment progress banner/bar updates during the run (default `crm-enrichment-progress` events still drive the CRM UI).

- [ ] **Case 14 — Delegated session.** Log in to the partner portal as an admin, delegate into a customer account that owns a CRM list, open Emma, and ask it to enrich a field. Assert: the run completes and the leads are enriched under the target customer account.

- [ ] **Case 15 — Error paths.** Three sub-checks via Emma: (a) enrich with an invalid `list_id` → informative error, no crash; (b) enrich an empty list → "no leads" error; (c) `enrich_lead_custom` with an invalid `lead_id` → informative error. Assert each returns a clear message and the chat stays responsive.

- [ ] **Case 16 — Engine confirmation.** After any successful Emma run above, check the test-env backend logs for the `[emma-enrich] engine=v3 runId=...` line, or inspect the `AW-EnrichmentJobs` record. Assert: the **V3** engine executed for Emma traffic — the legacy engine was not used.

- [ ] **Final step: Record results**

Summarize each case as pass/fail. All 16 must pass. No commit for this task (E2E is verification, not code) — unless a fix was required, in which case that fix was already committed under its own task during diagnosis.

---

## Self-Review

**Spec coverage** — every spec section maps to a task:
- Root cause / approach → Tasks 2–7 (engine swap).
- Component 1 (`processEnrichmentConfig`) → Task 2.
- Component 2 (config mapper) → Task 4.
- Component 3 (shared deps factory) → Task 3.
- Component 4 (3 tool handlers) → Tasks 6–7.
- Component 5 (batch cap) → Task 4 (`getEmmaEnrichMaxLeads`) + Task 6 (enforcement).
- Component 6 (representative preview sample) → Task 5 (`pickPreviewLeadIds`).
- Tool schema changes → Tasks 6–7.
- Error handling → Tasks 4–7 (throws surface to Emma; cap + empty-list errors).
- Observability & success criteria → Task 5 (engine-tagged log) + Task 11 Case 16.
- Legacy consumers → Task 1.
- Unit testing (TDD) → Tasks 2, 4, 5, 6, 7, 8.
- E2E Playwright matrix (all 16 cases) → Tasks 10–11.
- Release note → Task 9.

**Placeholder scan** — no TBD/TODO; every code step contains complete code; commands have expected output.

**Type consistency** — `EmmaEnrichmentOutputField`, `EmmaEnrichmentSummary`, `ConfigProcessingDeps`, `buildRawEnrichmentConfig`, `getEmmaEnrichMaxLeads`, `runEmmaEnrichment`, `pickPreviewLeadIds`, `resolveExecuteLeadIds` are each defined once and used with consistent signatures across tasks. `runEnrichment` / `RunEnrichmentResult` / `EnrichmentConfig` / `EnrichmentFieldConfig` match `crmEnrichmentServiceV3.ts`. `RunEnrichmentResult.failed` keys (`identityResolutionFailed`, `apolloFailed`, `llmOrParseFailed`, `updateFailed`, `searchWebFailed`) are used consistently in Task 5 tests and `failedCount` summation.

**Known risk** — Task 3 edits the large `crm.ts`. Mitigation: the move is verbatim and Step 5 runs the CRM route tests to confirm behavior is preserved.
