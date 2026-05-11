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

/** Maps the lead's standard column name → canonical FIELD_GROUPS field
 *  it enriches against. Used by `buildDefaultConfig` to auto-set aliasFor.  */
export const STANDARD_DATA_ALIASES: Record<string, string> = {
  firstName: 'first_name',
  lastName:  'last_name',
  email:     'email',
  phone:     'phone',
  title:     'title',
  linkedin:  'linkedin_url',
  company:   'company_name',
  website:   'website',
};

/** Standard lead columns that ARE enrichable — always surfaced in the config
 *  regardless of whether the list's fieldNames contains them. Mirrors the
 *  "Standard Fields" section of the Configure Display Fields dialog, minus
 *  non-enrichable system fields (createdAt, updatedAt, status, dealValue). */
const STANDARD_ENRICHABLE_FIELDS = [
  'firstName', 'lastName', 'email', 'company', 'phone', 'title', 'linkedin', 'notes',
] as const;

/** Custom-field names from list.fieldNames that should NOT appear in
 *  enrichment config (internal sidecars, UTM noise, lifecycle controls). */
const EXCLUDED_LIST_FIELD_NAMES = new Set<string>([
  // Internal metadata blobs
  'enrichmentMetadata', 'enrichmentData', 'syncMetadata', 'engagements', 'email_validation',
  // Lifecycle controls (managed elsewhere)
  'status', 'dealValue', 'dealCurrency',
  // System timestamps
  'createdAt', 'updatedAt',
]);

// Back-compat re-export — callers still importing the old name get the strict set.
export const RESERVED_FIELD_NAMES = TRULY_RESERVED_NAMES;

// ─── Dependency injection ─────────────────────────────────────────────────────

export interface FieldTypeSuggestion {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'date';
  enumOptions?: string[];
}

export interface ConfigServiceDeps {
  readListConfig(listId: string): Promise<EnrichmentConfig | null>;
  writeListConfig(listId: string, config: EnrichmentConfig): Promise<void>;
  loadListFieldNames(listId: string): Promise<string[]>;
  llmSuggestTypes(
    input: Array<{ name: string; instruction: string }>,
  ): Promise<FieldTypeSuggestion[]>;
}

// ─── Validation ───────────────────────────────────────────────────────────────

class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

function validateConfig(config: EnrichmentConfig): void {
  if (config.schemaVersion !== 1) {
    throw new ConfigValidationError(
      `schemaVersion must be 1; received ${config.schemaVersion}`,
    );
  }

  // Two fields routing to the same canonical name → routing conflict.
  // Covers both: explicit aliasFor collisions AND a self-canonical name
  // (e.g. `email`) clashing with an inferred alias (e.g. `Email`→`email`).
  // The waterfall fills the canonical once and the rename can only land on
  // one user-facing field — the other silently misses its value.
  const canonicalOwners = new Map<string, string>();   // canonical → user field name
  for (const field of config.fields) {
    const canonical = field.aliasFor
      ?? (CANONICAL_FIELD_NAMES.has(field.name) ? field.name : null);
    if (!canonical) continue;
    const existing = canonicalOwners.get(canonical);
    if (existing && existing !== field.name) {
      throw new ConfigValidationError(
        `Fields '${existing}' and '${field.name}' both map to '${canonical}'. ` +
        `Each canonical field can have only one config field — remove one.`,
      );
    }
    canonicalOwners.set(canonical, field.name);
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
  }
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

/** Merge a saved config with the current candidate set. Saved fields keep
 *  their user-customized settings; new candidates are appended as defaults.
 *  Saved fields the user added manually (e.g. `stag`) are preserved even
 *  if not in the current candidate set. */
function mergeSavedWithCandidates(
  saved: EnrichmentConfig,
  listFieldNames: string[],
): EnrichmentConfig {
  const savedByName = new Map(saved.fields.map(f => [f.name, f]));
  const candidates = candidateFieldNames(listFieldNames);
  const merged: EnrichmentFieldConfig[] = [];
  const usedNames = new Set<string>();

  // Pass 1: every candidate from the standard/custom set
  //   - If saved has a matching entry, use it (preserves user choices)
  //   - Else create a default-include:false entry
  for (const name of candidates) {
    const savedEntry = savedByName.get(name);
    if (savedEntry) {
      merged.push(savedEntry);
    } else {
      merged.push(buildDefaultField(name));
    }
    usedNames.add(name);
  }

  // Pass 2: preserve any saved fields the user added manually that aren't
  // in the candidate set (e.g. `stag`, `industry`)
  for (const field of saved.fields) {
    if (!usedNames.has(field.name)) merged.push(field);
  }

  return { ...saved, fields: merged };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getEnrichmentConfig(
  input: { listId: string; userId: string },
  deps: ConfigServiceDeps,
): Promise<{ config: EnrichmentConfig; isDefault: boolean }> {
  // Always read list field names — we surface the full candidate set in the
  // dialog (standard lead columns + custom fields), regardless of whether a
  // saved config exists. Saved settings are merged in on top.
  const fieldNames = await deps.loadListFieldNames(input.listId);
  const stored = await deps.readListConfig(input.listId);

  if (stored) {
    return { config: mergeSavedWithCandidates(stored, fieldNames), isDefault: false };
  }
  return {
    config: buildDefaultConfig(fieldNames, input.userId),
    isDefault: true,
  };
}

export async function setEnrichmentConfig(
  input: { listId: string; userId: string; config: EnrichmentConfig },
  deps: ConfigServiceDeps,
): Promise<EnrichmentConfig> {
  // Auto-infer aliasFor BEFORE validation — so heuristic matches don't get
  // rejected as "no aliasFor", and so the user never has to set it manually.
  // Explicit aliasFor (e.g. from API callers) is left untouched.
  const enriched = {
    ...input.config,
    fields: input.config.fields.map(f => ({
      ...f,
      aliasFor: f.aliasFor ?? inferAliasFor(f.name),
    })),
  };

  validateConfig(enriched);

  // Stamp server-side audit fields, overwriting whatever the client sent.
  // Trusting client-provided timestamps would let bad clients backdate writes.
  const stamped: EnrichmentConfig = {
    ...enriched,
    updatedAt: new Date().toISOString(),
    updatedBy: input.userId,
  };

  await deps.writeListConfig(input.listId, stamped);
  return stamped;
}

export async function suggestFieldTypes(
  input: { fields: Array<{ name: string; instruction: string }> },
  deps: ConfigServiceDeps,
): Promise<FieldTypeSuggestion[]> {
  if (input.fields.length === 0) return [];
  return deps.llmSuggestTypes(input.fields);
}
