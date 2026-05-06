/**
 * Per-list enrichment field configuration.
 *
 * Stored on `AW-LeadLists.enrichmentFieldConfig`. Gates which fields the
 * enrich.so reverse-lookup specialists write to a lead. The standard 5 fields
 * default ON (matches behavior before the config existed); extended fields
 * default OFF (opt-in).
 *
 * The cache is unaffected by this config — every reverse-lookup still fetches
 * (and caches) the full profile. Only the lead-side writes are gated.
 */

export type EnrichmentFieldName =
  | 'firstName'
  | 'lastName'
  | 'company'
  | 'title'
  | 'linkedin'
  | 'summary'
  | 'skills'
  | 'connectionCount'
  | 'location'
  | 'headline'
  | 'pastCompanies'
  | 'education';

export type EnrichmentFieldConfig = Record<EnrichmentFieldName, boolean>;

export const STANDARD_FIELDS: readonly EnrichmentFieldName[] = [
  'firstName',
  'lastName',
  'company',
  'title',
  'linkedin',
] as const;

export const EXTENDED_FIELDS: readonly EnrichmentFieldName[] = [
  'summary',
  'skills',
  'connectionCount',
  'location',
  'headline',
  'pastCompanies',
  'education',
] as const;

export const ALL_ENRICHMENT_FIELDS: readonly EnrichmentFieldName[] = [
  ...STANDARD_FIELDS,
  ...EXTENDED_FIELDS,
] as const;

/** Default config: standard fields ON, extended fields OFF. */
export function getDefaultEnrichmentFieldConfig(): EnrichmentFieldConfig {
  const cfg = {} as EnrichmentFieldConfig;
  for (const f of STANDARD_FIELDS) cfg[f] = true;
  for (const f of EXTENDED_FIELDS) cfg[f] = false;
  return cfg;
}

/**
 * Merge a partial/raw config (e.g. from DynamoDB) with defaults so every field
 * has a known boolean state. Unknown keys are dropped.
 */
export function normalizeEnrichmentFieldConfig(
  raw: Partial<Record<string, unknown>> | null | undefined,
): EnrichmentFieldConfig {
  const cfg = getDefaultEnrichmentFieldConfig();
  if (!raw || typeof raw !== 'object') return cfg;
  for (const f of ALL_ENRICHMENT_FIELDS) {
    if (typeof raw[f] === 'boolean') cfg[f] = raw[f] as boolean;
  }
  return cfg;
}

/**
 * Compute the union of multiple list configs — used when a lead belongs to
 * more than one list. Any list that enables a field wins.
 */
export function unionEnrichmentFieldConfigs(
  configs: readonly EnrichmentFieldConfig[],
): EnrichmentFieldConfig {
  const result = getDefaultEnrichmentFieldConfig();
  // Reset to all-false so that if no list enables a field, it stays off.
  for (const f of ALL_ENRICHMENT_FIELDS) result[f] = false;
  for (const cfg of configs) {
    for (const f of ALL_ENRICHMENT_FIELDS) {
      if (cfg[f]) result[f] = true;
    }
  }
  return result;
}
