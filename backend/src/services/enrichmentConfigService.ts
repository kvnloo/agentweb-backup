// Enrichment config CRUD + LLM-driven type suggestion for newly added fields.
//
// Design ref: tasks/crm-enrichment-v3.1-design.md §4.1 (API), §7.1 (storage).
// Persisted as `enrichmentConfig` on the `AW-LeadLists` row; per-list scoped.
// Validation runs at write time — reads never mutate stored data.

import type {
  EnrichmentConfig,
  EnrichmentFieldConfig,
} from './crmEnrichmentServiceV3';
import { FIELD_GROUPS } from './enrichmentGroups';

// Set of every canonical field name across all FIELD_GROUPS — for aliasFor validation
const CANONICAL_FIELD_NAMES = new Set<string>(
  Object.values(FIELD_GROUPS).flatMap(g => g.fields),
);

// ─── Alias inference ─────────────────────────────────────────────────────────
// Server-side decision: which user-named field maps to which canonical
// FIELD_GROUPS field. Runs at save time so the user never sees the mapping
// in the UI. Phase 1: pure heuristics (camelCase → snake_case + known map).
// Phase 1.5: extend with an LLM fallback for opaque names like `stag`.

function camelToSnake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** Common natural-language synonyms → canonical FIELD_GROUPS names. Catches
 *  cases the camelCase heuristic misses ("funding_round" → "funding_stage",
 *  "tech" → "tech_stack", etc.). Drift risk low — extend as new common
 *  names come up in real lists. */
const CANONICAL_SYNONYMS: Record<string, string> = {
  // Funding / financial
  funding_round: 'funding_stage',
  fundingRound: 'funding_stage',
  funding: 'funding_stage',
  series: 'funding_stage',
  revenue: 'revenue_range',
  annual_revenue: 'revenue_range',
  annualRevenue: 'revenue_range',
  arr: 'revenue_range',

  // Technographics
  tech: 'tech_stack',
  technology: 'tech_stack',
  tools: 'tech_stack',
  techStack: 'tech_stack',

  // Firmographics
  employees: 'employee_count',
  size: 'employee_count',
  company_size: 'employee_count',
  founded: 'founded_year',
  industry_sector: 'industry',
  hq: 'hq_location',
  headquarters: 'hq_location',
  description: 'company_description',

  // Identity
  name: 'first_name',
  full_name: 'first_name',         // imperfect — won't split, but routes to person_identity
};

/** Resolve a field name to its canonical FIELD_GROUPS name. Returns the name
 *  itself when it is already canonical, the inferred canonical when a
 *  heuristic match exists, or undefined when there is no canonical analog. */
export function canonicalFieldName(name: string): string | undefined {
  if (CANONICAL_FIELD_NAMES.has(name)) return name;
  return inferAliasFor(name);
}

/** Infer `aliasFor` for a single field. Returns the canonical name, or
 *  undefined if no high-confidence match. */
function inferAliasFor(fieldName: string): string | undefined {
  // 1. Already canonical → no alias needed (orchestrator routes by name).
  if (CANONICAL_FIELD_NAMES.has(fieldName)) return undefined;

  // 2. Known standard column → canonical mapping (firstName → first_name, etc.).
  if (STANDARD_DATA_ALIASES[fieldName]) return STANDARD_DATA_ALIASES[fieldName];

  // 3. camelCase → snake_case match (companyLinkedinUrl → company_linkedin_url).
  const snake = camelToSnake(fieldName);
  if (snake !== fieldName && CANONICAL_FIELD_NAMES.has(snake)) return snake;

  // 4. Synonym map — covers natural-language variants the snake/camel
  //    transform can't reach (funding_round → funding_stage, tech → tech_stack).
  const synonym = CANONICAL_SYNONYMS[fieldName] ?? CANONICAL_SYNONYMS[snake];
  if (synonym && CANONICAL_FIELD_NAMES.has(synonym)) return synonym;

  // 5. Phase 1 stops here. Opaque names like `stag` stay ungrouped.
  //    Future: LLM fallback against {field name, instruction, FIELD_GROUPS list}.
  return undefined;
}

// ─── Reserved + standard field names ─────────────────────────────────────────
// Two distinct categories:
//   TRULY_RESERVED — system/sidecar columns that must never appear in
//     customFields. Rejected outright by validation.
//   STANDARD_DATA_ALIASES — standard CRM data columns (firstName, email, ...).
//     These ARE enrichable; default config auto-maps them to their canonical
//     FIELD_GROUPS field via `aliasFor`. Users see them in the config so they
//     can opt into enriching standard columns the same as custom ones.

export const TRULY_RESERVED_NAMES = [
  'leadId',
  'listId',
  'enrichmentMetadata',
  'customFields',
  'createdAt',
  'updatedAt',
] as const;

const TRULY_RESERVED_SET = new Set<string>(TRULY_RESERVED_NAMES);

/** Fields that are auto-derived from other lead data and should never receive
 *  an aliasFor assignment — they have no external enrichment source. */
const ALIAS_INFERENCE_BLOCKLIST = new Set(['emailDomain', 'email_domain']);

/** Maps the lead's standard column name → canonical FIELD_GROUPS field
 *  it enriches against. Used by `buildDefaultConfig` to auto-set aliasFor.  */
export const STANDARD_DATA_ALIASES: Record<string, string> = {
  firstName:       'first_name',
  lastName:        'last_name',
  email:           'email',
  phone:           'phone',
  title:           'title',
  linkedin:        'linkedin_url',
  company:         'company_name',
  website:         'website',
  companyLinkedin: 'company_linkedin_url',
};

/** Standard lead columns that ARE enrichable — always surfaced in the config
 *  regardless of whether the list's fieldNames contains them. Mirrors the
 *  "Standard Fields" section of the Configure Display Fields dialog, minus
 *  non-enrichable system fields (createdAt, updatedAt, status, dealValue). */
export const STANDARD_ENRICHABLE_FIELDS = [
  'firstName', 'lastName', 'email', 'company', 'phone', 'title', 'linkedin', 'companyLinkedin', 'notes',
] as const;

/** Custom-field names from list.fieldNames that should NOT appear in
 *  enrichment config (internal sidecars, UTM noise, lifecycle controls). */
const EXCLUDED_LIST_FIELD_NAMES = new Set<string>([
  // Internal metadata blobs
  'enrichmentMetadata', 'enrichmentData', 'syncMetadata', 'engagements', 'email_validation',
  // Lifecycle controls (managed elsewhere)
  'status', 'dealValue', 'dealCurrency',
  // CRM pipeline state + audit sidecars (set by the inbox/working/paying
  // workflow, not enrichable from external sources)
  'contactStatus', 'contactStatusNote', 'contactStatusReason',
  'contactStatusUpdatedAt', 'contactStatusUpdatedBy',
  // System timestamps
  'createdAt', 'updatedAt',
  // Identity-derived fields — auto-computed from other lead data, not enrichable
  'emailDomain',
]);

// Back-compat re-export — callers still importing the old name get the strict set.
export const RESERVED_FIELD_NAMES = TRULY_RESERVED_NAMES;

// ─── Dependency injection ─────────────────────────────────────────────────────

export interface FieldTypeSuggestion {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'date';
  enumOptions?: string[];
}

export interface SmartFieldClassification {
  isSmartField: boolean;
  dependencies: string[];
  fieldType?: 'string' | 'number' | 'boolean' | 'date' | 'enum';
  enumOptions?: string[];
}

export interface ConfigServiceDeps {
  readListConfig(listId: string): Promise<EnrichmentConfig | null>;
  writeListConfig(listId: string, config: EnrichmentConfig): Promise<void>;
  loadListFieldNames(listId: string): Promise<string[]>;
  /** Register custom-field column names on the parent list so the Configure
   *  Display Fields dialog (which reads list.fieldNames) shows a configured
   *  enrichment column even before any lead has a value for it. Without this,
   *  a field whose value is never found — or is dropped by the critic — never
   *  appears as a column and the user thinks it "disappeared". Implementations
   *  should fail soft (the config write already succeeded). */
  mergeListFieldNames(listId: string, fieldNames: string[]): Promise<void>;
  llmSuggestTypes(
    input: Array<{ name: string; instruction: string }>,
  ): Promise<FieldTypeSuggestion[]>;
  /** Called once per save to map opaque user-named fields (where heuristics
   *  returned undefined) to canonical FIELD_GROUPS names via an LLM.
   *  Returns { fieldName: canonicalName | null } — null means no confident
   *  match (field stays ungrouped). Implementations should fail soft
   *  (return {} on error) so heuristic results still apply. */
  llmInferAliases(
    input: Array<{ name: string; instruction: string }>,
  ): Promise<Record<string, string | null>>;
  /** Called once per save to classify fields as smart (computed/derived) or
   *  normal (directly fetchable). For smart fields also extracts canonical
   *  dependency field names. Implementations should fail soft (return {} on
   *  error) so the rest of the save still proceeds. */
  llmClassifySmartFields(
    input: Array<{ name: string; instruction: string }>,
  ): Promise<Record<string, SmartFieldClassification>>;
}

/** Subset of ConfigServiceDeps needed to PROCESS a config (resolve aliases,
 *  classify smart fields, validate) without persisting it. Used by callers
 *  that build a config in memory and run enrichment directly — e.g. Emma. */
export type ConfigProcessingDeps = Pick<
  ConfigServiceDeps,
  'readListConfig' | 'llmInferAliases' | 'llmClassifySmartFields'
>;

// ─── Validation ───────────────────────────────────────────────────────────────

class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

function validateConfig(config: EnrichmentConfig): { warnings: string[] } {
  if (config.schemaVersion !== 1) {
    throw new ConfigValidationError(
      `schemaVersion must be 1; received ${config.schemaVersion}`,
    );
  }

  // Two fields routing to the same canonical name → routing collision.
  // Covers both: explicit aliasFor collisions AND a self-canonical name
  // (e.g. `email`) clashing with an inferred alias (e.g. `Email`→`email`).
  // Real CRM lists commonly have data in both `company` and `company_name`
  // (or `email` + `Email`), so we ALLOW the collision and fan out fills to
  // every user-facing field at enrichment time. We surface a warning so the
  // user understands both columns will receive the same enriched value.
  const canonicalToUserFields = new Map<string, string[]>();
  for (const field of config.fields) {
    const canonical = field.aliasFor
      ?? (CANONICAL_FIELD_NAMES.has(field.name) ? field.name : null);
    if (!canonical) continue;
    const names = canonicalToUserFields.get(canonical) ?? [];
    if (!names.includes(field.name)) names.push(field.name);
    canonicalToUserFields.set(canonical, names);
  }
  // Each warning is just the duplicate group descriptor (e.g. `'company' and
  // 'company_name'`). The frontend wraps the list with a single shared header
  // + explainer, so the message reads cleanly when several groups collide.
  const warnings: string[] = [];
  for (const [, names] of canonicalToUserFields.entries()) {
    if (names.length < 2) continue;
    const quoted = names.map(n => `'${n}'`);
    const list = names.length === 2
      ? `${quoted[0]} and ${quoted[1]}`
      : `${quoted.slice(0, -1).join(', ')}, and ${quoted[quoted.length - 1]}`;
    warnings.push(list);
  }

  const seen = new Set<string>();
  for (const field of config.fields) {
    if (seen.has(field.name)) {
      throw new ConfigValidationError(
        `'${field.name}' is already in the list. Find the existing row and toggle it on instead of adding a duplicate.`,
      );
    }
    seen.add(field.name);

    if (TRULY_RESERVED_SET.has(field.name)) {
      throw new ConfigValidationError(
        `field name '${field.name}' is reserved and cannot be used for a custom enrichment field`,
      );
    }

    if (field.type === 'enum') {
      if (!field.enumOptions || field.enumOptions.length === 0) {
        throw new ConfigValidationError(
          `enum field '${field.name}' must have non-empty enumOptions`,
        );
      }
    }

    if (field.aliasFor != null) {
      if (typeof field.aliasFor !== 'string' || !CANONICAL_FIELD_NAMES.has(field.aliasFor)) {
        throw new ConfigValidationError(
          `field '${field.name}' aliasFor='${field.aliasFor}' is not a known canonical field`,
        );
      }
    }

    if (field.smartDependencies != null) {
      for (const dep of field.smartDependencies) {
        if (!CANONICAL_FIELD_NAMES.has(dep)) {
          throw new ConfigValidationError(
            `smart field '${field.name}' dependency '${dep}' is not a known canonical field`,
          );
        }
      }
    }
  }

  return { warnings };
}

// ─── Default-config generator ─────────────────────────────────────────────────

/** Build the canonical candidate set the dialog should always show:
 *  STANDARD_ENRICHABLE_FIELDS ∪ (list.fieldNames \ exclusions \ truly-reserved).
 *  Order: standard fields first (predictable layout), then custom fields. */
function candidateFieldNames(listFieldNames: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of STANDARD_ENRICHABLE_FIELDS) {
    if (!seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
  }
  for (const name of listFieldNames) {
    if (seen.has(name)) continue;
    if (TRULY_RESERVED_SET.has(name)) continue;
    if (EXCLUDED_LIST_FIELD_NAMES.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

function buildDefaultField(name: string): EnrichmentFieldConfig {
  const aliasFor = STANDARD_DATA_ALIASES[name];
  return {
    name,
    type: 'string',
    instruction: '',
    include: true,                      // opt-out: pre-select all (UX choice)
    overwritePolicy: 'fill_if_empty',
    ...(aliasFor ? { aliasFor } : {}),
  };
}

function buildDefaultConfig(
  listFieldNames: string[],
  userId: string,
): EnrichmentConfig {
  const candidates = candidateFieldNames(listFieldNames);
  return {
    fields: candidates.map(buildDefaultField),
    globalOverwriteDefault: 'fill_if_empty',
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: userId,
  };
}

/** Merge a saved config with the current candidate set.
 *
 *  Order is intentional, optimized for "I just added a field, where did it go?":
 *    1. User-added saved-only fields FIRST (manual adds like Description,
 *       stag — not present in list.fieldNames or the standard set). These
 *       are the most-recently-added and most-looked-at, so they go on top.
 *    2. Standard + list-custom candidates (with saved settings if present,
 *       otherwise defaults).
 *
 *  Saved entries always keep their user-customized settings; brand-new
 *  candidates surface with `include:true` defaults. */
function mergeSavedWithCandidates(
  saved: EnrichmentConfig,
  listFieldNames: string[],
): EnrichmentConfig {
  // Drop saved entries that are now excluded (e.g. older configs that
  // pre-selected contactStatus* lifecycle columns). Treats the exclusion
  // list as authoritative — these can't usefully enrich, so they shouldn't
  // resurface even if a prior save persisted them.
  const visibleSaved = saved.fields.filter(
    f => !EXCLUDED_LIST_FIELD_NAMES.has(f.name) && !TRULY_RESERVED_SET.has(f.name),
  );
  const savedByName = new Map(visibleSaved.map(f => [f.name, f]));
  const candidates = candidateFieldNames(listFieldNames);
  const candidateSet = new Set(candidates);
  const merged: EnrichmentFieldConfig[] = [];
  const usedNames = new Set<string>();

  // Pass 1: user-added saved-only fields first (not in current candidates).
  // Preserves saved order among themselves.
  for (const field of visibleSaved) {
    if (!candidateSet.has(field.name) && !usedNames.has(field.name)) {
      merged.push(field);
      usedNames.add(field.name);
    }
  }

  // Pass 2: standard + list-custom candidates. Saved entries keep their
  // settings; otherwise default.
  for (const name of candidates) {
    if (usedNames.has(name)) continue;
    const savedEntry = savedByName.get(name);
    merged.push(savedEntry ?? buildDefaultField(name));
    usedNames.add(name);
  }

  return { ...saved, fields: merged };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getEnrichmentConfig(
  input: { listId: string; userId: string },
  deps: ConfigServiceDeps,
): Promise<{ config: EnrichmentConfig; isDefault: boolean; knownColumns: string[] }> {
  // Always read list field names — we surface the full candidate set in the
  // dialog (standard lead columns + custom fields), regardless of whether a
  // saved config exists. Saved settings are merged in on top.
  const fieldNames = await deps.loadListFieldNames(input.listId);
  const stored = await deps.readListConfig(input.listId);

  // knownColumns = the rows that will auto-resurface on next dialog open
  // (standard CRM cols ∪ list schema cols, minus excluded/reserved). Frontend
  // hides the trash icon for these — delete is destructive only for fields
  // outside this set (manually-added saved-only rows).
  const knownColumns = candidateFieldNames(fieldNames);

  if (stored) {
    return {
      config: mergeSavedWithCandidates(stored, fieldNames),
      isDefault: false,
      knownColumns,
    };
  }
  return {
    config: buildDefaultConfig(fieldNames, input.userId),
    isDefault: true,
    knownColumns,
  };
}

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
      // Strip server-managed classification keys from the client payload.
      // These are computed server-side and must not be client-injectable:
      // - smartCondition / smartDependencies: trust these → skip POST eval
      // - notSmartInstruction: set this === instruction → suppress classification
      ({ smartCondition: _sc, smartDependencies: _sd, notSmartInstruction: _nsi, ...f }) => ({
        ...f,
        // Blocklisted fields (e.g. emailDomain) must never get an aliasFor —
        // strip even if the stored config has a stale one from old inference.
        aliasFor: ALIAS_INFERENCE_BLOCKLIST.has(f.name) ? undefined : (f.aliasFor ?? inferAliasFor(f.name)),
      }),
    ),
  };

  // Fire the DB read immediately — independent of the LLM steps below.
  // Awaited in Step 3a; running it here overlaps the read with LLM I/O.
  const storedConfigPromise = deps.readListConfig(input.listId).catch(() => null);

  // Step 2: LLM fallback for fields the heuristic couldn't resolve. One LLM
  // call total per save (not per enrichment run) — cheap. LLM matches opaque
  // names like `stag` → `funding_stage` based on the user's instruction text.
  const llmCandidates = enriched.fields.filter(f => !f.aliasFor && !ALIAS_INFERENCE_BLOCKLIST.has(f.name));
  if (llmCandidates.length > 0) {
    try {
      const llmAliases = await deps.llmInferAliases(
        llmCandidates.map(f => ({ name: f.name, instruction: f.instruction || '' })),
      );
      enriched = {
        ...enriched,
        fields: enriched.fields.map(f => {
          if (f.aliasFor) return f;   // heuristic already won
          const llmGuess = llmAliases[f.name];
          if (llmGuess && CANONICAL_FIELD_NAMES.has(llmGuess)) {
            return { ...f, aliasFor: llmGuess };
          }
          return f;
        }),
      };
    } catch (err) {
      // Fail soft — heuristic results stand. Don't block save on LLM failure.
      // eslint-disable-next-line no-console
      console.warn('[enrichmentConfigService] LLM alias inference failed:', err);
    }
  }

  // Step 3a: Restore server-persisted classification keys from DB.
  // Client-supplied values were stripped in Step 1 — client must not control
  // these. Load from DB (authoritative) and re-attach for fields that match by
  // name. If no stored config exists (new list), nothing to restore.
  {
    const storedConfig = await storedConfigPromise;
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

  // Step 3b: Classify smart fields via LLM. Only classify fields that have an
  // instruction, are enabled, and haven't been classified with the current
  // instruction yet (either as smart or not-smart).
  // smartCondition holds the instruction used when LLM said "smart".
  // notSmartInstruction holds the instruction used when LLM said "not smart".
  // If either matches the current instruction, skip — result is already cached.
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
          if (!cls) return f;  // not in classification batch — leave unchanged

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
              typeOverride = { type: inferredType, enumOptions: undefined };  // clear stale enumOptions
            }
            // else: enum with no valid options — skip type change
          }

          if (cls.isSmartField) {
            // Only canonical FIELD_GROUPS names are kept as dependencies.
            // This means smart fields cannot depend on other smart fields —
            // a user-field name like `isQualified` would be filtered here.
            // See the POST eval loop in crmEnrichmentServiceV3 for full context.
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
          // LLM says not smart — strip stale smart tags, cache this instruction
          // in notSmartInstruction so we don't re-classify on the next save.
          const out = { ...f, ...typeOverride, notSmartInstruction: f.instruction };
          delete (out as any).smartCondition;
          delete (out as any).smartDependencies;
          return out;
        }),
      };
    } catch (err) {
      // Fail soft — alias results still stand, save proceeds without smart tags.
      // eslint-disable-next-line no-console
      console.warn('[enrichmentConfigService] smart field classification failed:', err);
    }
  }

  const { warnings } = validateConfig(enriched);

  // Stamp server-side audit fields, overwriting whatever the client sent.
  // Trusting client-provided timestamps would let bad clients backdate writes.
  const stamped: EnrichmentConfig = {
    ...enriched,
    updatedAt: new Date().toISOString(),
    updatedBy: input.userId,
  };

  return { config: stamped, warnings };
}

/** Config field names that represent CUSTOM columns (i.e. not standard lead
 *  columns rendered through dedicated UI, and not internal sidecars). These
 *  are the names the Configure Display Fields dialog lists under "Custom
 *  Fields" — so registering them on list.fieldNames makes a configured
 *  enrichment field visible as a column even when it has no value yet. */
export function customColumnNamesFromConfig(config: EnrichmentConfig): string[] {
  const standard = new Set<string>([...STANDARD_ENRICHABLE_FIELDS, 'website']);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of config.fields ?? []) {
    const name = (f.name ?? '').trim();
    if (!name) continue;
    if (standard.has(name)) continue;
    if (EXCLUDED_LIST_FIELD_NAMES.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export async function setEnrichmentConfig(
  input: { listId: string; userId: string; config: EnrichmentConfig },
  deps: ConfigServiceDeps,
): Promise<{ config: EnrichmentConfig; warnings: string[] }> {
  const { config, warnings } = await processEnrichmentConfig(input, deps);
  await deps.writeListConfig(input.listId, config);
  // Register configured custom columns on the parent list so they show up in
  // the Configure Display Fields dialog immediately — independent of whether
  // enrichment ever finds (or the critic keeps) a value. Fail soft: the config
  // itself is already persisted.
  const customColumns = customColumnNamesFromConfig(config);
  if (customColumns.length > 0) {
    try {
      await deps.mergeListFieldNames(input.listId, customColumns);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[setEnrichmentConfig] fieldNames registration failed:', (err as Error).message);
    }
  }
  return { config, warnings };
}

export async function suggestFieldTypes(
  input: { fields: Array<{ name: string; instruction: string }> },
  deps: ConfigServiceDeps,
): Promise<FieldTypeSuggestion[]> {
  if (input.fields.length === 0) return [];
  return deps.llmSuggestTypes(input.fields);
}
