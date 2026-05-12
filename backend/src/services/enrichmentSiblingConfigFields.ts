// Tier 0b — CRM-history sibling enrichment for config-requested fields.
//
// Runs AFTER resolveIdentity (Tier 0a) using the siblings it already fetched —
// no additional DDB queries. Two-phase field matching:
//   1. Canonical match: configField.aliasFor === siblingField.aliasFor (free, deterministic)
//   2. LLM mapping: for remaining unaliased config fields, one LLM call per run
//      builds a mapping table (configFieldName → [likely sibling field names]).
//      Applied to all leads; never called more than once per run.
//
// TTL: per-field freshness uses the field's FIELD_GROUP ttlDays. Identity fields
// (no group) default to 90 days. Sibling freshness proxy = sibling.updatedAt.

import type { LeadRecord } from './crmEnrichmentService';
import type { EnrichmentFieldConfig } from './crmEnrichmentServiceV3';
import type { SiblingLeadResult } from './enrichmentIdentityResolver';
import type { EnrichedFieldMeta } from '../utils/enrichedFieldValue';
import { FIELD_GROUPS } from './enrichmentGroups';
import { createLLMService } from '../utils/llmService';

const IDENTITY_FIELDS = new Set([
  'firstName', 'lastName', 'email', 'linkedin', 'company', 'website', 'title',
]);

const DEFAULT_TTL_DAYS = 90;
// Must be a model that `createLLMService` can construct successfully — the
// Azure deployment used by the rest of the v3 enrichment pipeline. Bedrock
// Claude IDs only resolve here when an inference-profile mapping is added
// in `llmService.ts`, so changing this requires updating that map too.
const MAPPING_MODEL = process.env.CRM_ENRICH_V3_EXTRACT_MODEL || 'gpt-5-chat-2';

// ─── TTL helpers ──────────────────────────────────────────────────────────────

function ttlMsForField(fieldName: string, aliasFor?: string): number {
  const canonicalName = aliasFor ?? fieldName;
  for (const cfg of Object.values(FIELD_GROUPS)) {
    if (cfg.fields.includes(canonicalName)) {
      return cfg.ttlDays * 86400 * 1000;
    }
  }
  return DEFAULT_TTL_DAYS * 86400 * 1000;
}

function siblingIsFresha(sib: SiblingLeadResult, maxAgeMs: number): boolean {
  if (!sib.updatedAt) return true; // no timestamp → don't reject
  return Date.now() - new Date(sib.updatedAt).getTime() <= maxAgeMs;
}

// ─── Canonical match ──────────────────────────────────────────────────────────

// Build a map: configFieldName → list of sibling field names that share the
// same aliasFor canonical. Operates on config only — no per-lead data needed.
export function buildCanonicalFieldMap(
  configFields: EnrichmentFieldConfig[],
): Map<string, string[]> {
  // aliasFor → [configFieldNames that use it]
  const byCanonical = new Map<string, string[]>();
  for (const f of configFields) {
    if (!f.aliasFor) continue;
    const arr = byCanonical.get(f.aliasFor) ?? [];
    arr.push(f.name);
    byCanonical.set(f.aliasFor, arr);
  }

  // For each config field with aliasFor, find sibling custom field names that
  // also alias to the same canonical. Since we don't know sibling field names
  // ahead of time, the canonical name itself is the lookup key used at copy
  // time (see copySiblingConfigFields).
  const result = new Map<string, string[]>();
  for (const f of configFields) {
    if (f.aliasFor) {
      // configFieldName → canonical key (used to look up sib.customFields)
      result.set(f.name, [f.aliasFor]);
    }
  }
  return result;
}

// ─── LLM mapping (one call per run for unaliased fields) ─────────────────────

export async function buildLLMFieldMapping(
  unaliasedConfigFields: EnrichmentFieldConfig[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (unaliasedConfigFields.length === 0) return result;

  const fieldList = unaliasedConfigFields.map(f =>
    `- ${f.name}${f.instruction ? ` (${f.instruction})` : ''}`,
  ).join('\n');

  const systemPrompt =
    `You are a CRM data schema expert. Given a list of CRM field names, return a JSON object ` +
    `mapping each field name to an array of common alternative names or synonyms that other ` +
    `CRM systems might use for the same data. Include the original name in the array. ` +
    `Return ONLY a JSON object, no prose, no markdown.`;

  const userPrompt =
    `For each field below, list likely alternative field names (max 6 per field):\n${fieldList}\n\n` +
    `Return: {"fieldName": ["alias1", "alias2", ...], ...}`;

  try {
    const llm = createLLMService(MAPPING_MODEL, 0.0);
    const parsed = await llm.generateJSONContent<Record<string, string[]>>(systemPrompt, userPrompt);
    for (const [fieldName, aliases] of Object.entries(parsed)) {
      if (Array.isArray(aliases)) {
        result.set(fieldName, aliases.map(a => String(a).trim()).filter(Boolean));
      }
    }
  } catch (err) {
    console.warn('[tier0b] LLM field mapping failed:', (err as Error).message);
    // Fallback: map each field to itself only
    for (const f of unaliasedConfigFields) {
      result.set(f.name, [f.name]);
    }
  }
  return result;
}

// ─── Run-start mapping builder ────────────────────────────────────────────────

export interface SiblingFieldMappingTable {
  // configFieldName → ordered list of sibling field name candidates to try
  canonical: Map<string, string[]>;   // from aliasFor
  llm: Map<string, string[]>;         // from LLM for unaliased fields
}

export async function buildSiblingFieldMappingTable(
  configFields: EnrichmentFieldConfig[],
): Promise<SiblingFieldMappingTable> {
  const nonIdentity = configFields.filter(f => !IDENTITY_FIELDS.has(f.name));
  const withAlias = nonIdentity.filter(f => !!f.aliasFor);
  const withoutAlias = nonIdentity.filter(f => !f.aliasFor);

  const [canonical, llm] = await Promise.all([
    Promise.resolve(buildCanonicalFieldMap(withAlias)),
    buildLLMFieldMapping(withoutAlias),
  ]);

  return { canonical, llm };
}

// ─── Per-lead copy ────────────────────────────────────────────────────────────

export interface SiblingConfigFieldResult {
  fills: Array<{ field: string; value: string; meta: EnrichedFieldMeta }>;
}

export function copySiblingConfigFields(
  lead: LeadRecord,
  siblings: SiblingLeadResult[],
  configFields: EnrichmentFieldConfig[],
  mappingTable: SiblingFieldMappingTable,
  refreshFields?: Set<string>,
): SiblingConfigFieldResult {
  const fills: SiblingConfigFieldResult['fills'] = [];
  const enrichedAt = new Date().toISOString();

  for (const configField of configFields) {
    if (IDENTITY_FIELDS.has(configField.name)) continue;

    // Skip if lead already has this field
    const topVal = (lead as any)[configField.name];
    const customVal = lead.customFields?.[configField.name];
    const alreadyFilled =
      (typeof topVal === 'string' && topVal.trim() !== '') ||
      (typeof customVal === 'string' && customVal.trim() !== '');
    if (alreadyFilled) continue;

    // Skip if user force-refreshed
    if (refreshFields?.has(`${lead.leadId}:${configField.name}`)) continue;

    const maxAgeMs = ttlMsForField(configField.name, configField.aliasFor);

    // Candidates: canonical aliases first, then LLM aliases
    const candidateKeys: string[] = [
      ...(mappingTable.canonical.get(configField.name) ?? []),
      ...(mappingTable.llm.get(configField.name) ?? []),
      configField.name, // always try exact name match as last resort
    ];
    // Dedupe preserving order
    const seen = new Set<string>();
    const uniqueKeys = candidateKeys.filter(k => {
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // Walk siblings freshest-first
    for (const sib of siblings) {
      if (!siblingIsFresha(sib, maxAgeMs)) continue;
      if (!sib.customFields) continue;

      for (const key of uniqueKeys) {
        const v = sib.customFields[key];
        if (typeof v !== 'string' || v.trim() === '') continue;
        fills.push({
          field: configField.name,
          value: v,
          meta: {
            source: 'crm-history',
            provider: 'agentweb',
            enrichedAt,
            siblingLeadId: sib.leadId,
            siblingListId: sib.listId,
            siblingUserId: sib.userId,
          },
        });
        break; // field filled — move to next config field
      }
      // If we filled this field from this sibling, stop checking more siblings
      const alreadyFilled2 = fills.some(f => f.field === configField.name);
      if (alreadyFilled2) break;
    }
  }

  return { fills };
}
