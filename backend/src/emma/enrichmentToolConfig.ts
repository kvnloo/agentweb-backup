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
