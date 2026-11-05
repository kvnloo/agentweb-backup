// Real DynamoDB + LLM dependency implementations for the enrichment config
// service. Extracted from routes/crm.ts so both the CRM routes and Emma's
// enrichment tools build the deps the same way (DRY).

import { crmDb } from './db';
import type { LLMUsageContext } from '../utils/llmService';
import type {
  ConfigServiceDeps,
  ConfigProcessingDeps,
  FieldTypeSuggestion,
  SmartFieldClassification,
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

/**
 * ENG-1858: the config-save LLM calls used to meter to "system" because these
 * deps are built without request context. The saving user is now threaded in per
 * call (callLLM resolves the ENG-1217 billing subject at metering time).
 */
function enrichmentConfigUsageContext(userId?: string): LLMUsageContext {
  return { userId, feature: 'crm_enrichment_config' };
}

async function llmInferAliases(
  fields: Array<{ name: string; instruction: string }>,
  userId?: string,
): Promise<Record<string, string | null>> {
  if (fields.length === 0) return {};
  // Lazy import — avoids circular deps + keeps the LLM service out of the
  // hot path for callers that never hit alias inference.
  const { FIELD_GROUPS, CARD_REVENUE_GROUP } = await import('./enrichmentGroups');
  const { buildAliasInferenceSystemPrompt } = await import('./enrichmentPrompts');

  // Build the canonical-field cheat sheet for the system prompt. Grouping
  // by FIELD_GROUPS gives the LLM more context (it understands "Series A"
  // → funding_stage instead of guessing across groups). Enigma card revenue
  // (ENG-1388) is left out: it is paid per value and only routed by exact name.
  const canonicalCheatsheet = Object.entries(FIELD_GROUPS)
    .filter(([group]) => group !== CARD_REVENUE_GROUP)
    .map(([group, cfg]) => `  ${group}: ${cfg.fields.join(', ')}`)
    .join('\n');

  const systemPrompt = buildAliasInferenceSystemPrompt(canonicalCheatsheet);

  const userPrompt =
    `Map each user field to a canonical name (or null):\n` +
    fields.map(f => `- ${f.name}${f.instruction ? ` — "${f.instruction}"` : ''}`).join('\n') +
    `\n\nReturn JSON: {"<userFieldName>": "<canonical_name>" | null} for each input.`;

  try {
    const { createEnrichmentHelperLLM } = await import('./enrichmentMappingLlm');
    const llm = await createEnrichmentHelperLLM(userId, process.env.CRM_ENRICH_V3_ALIAS_MODEL);
    const result = await llm.generateJSONContent<Record<string, string | null>>(
      systemPrompt,
      userPrompt,
      'json',
      undefined,
      enrichmentConfigUsageContext(userId),
    );
    return result ?? {};
  } catch (err) {
    console.warn('[enrichmentConfigDeps] llmInferAliases failed:', (err as Error).message);
    return {};
  }
}

const normalizedSet = (values: unknown): string[] =>
  Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string').map(v => v.trim().toLowerCase()).sort() : [];

/**
 * Keeps, per field, only a classification both samples agree on: the same smart flag, the same type and,
 * for an enum, the same set of options. A smart field keeps the dependencies named by either sample (a
 * missing input is worse than an extra one); none is fine, the evaluator also gets the lead's own columns.
 * Fields missing from either sample are dropped.
 */
export function agreeingClassifications(
  a: Record<string, SmartFieldClassification>,
  b: Record<string, SmartFieldClassification>,
): Record<string, SmartFieldClassification> {
  const out: Record<string, SmartFieldClassification> = {};
  for (const [name, x] of Object.entries(a)) {
    const y = b[name];
    if (!x || !y || typeof x !== 'object' || typeof y !== 'object') continue;
    if (!!x.isSmartField !== !!y.isSmartField || (x.fieldType ?? null) !== (y.fieldType ?? null)) continue;
    if (x.fieldType === 'enum' && normalizedSet(x.enumOptions).join('\u0000') !== normalizedSet(y.enumOptions).join('\u0000')) continue;
    if (!x.isSmartField) { out[name] = x; continue; }
    out[name] = { ...x, dependencies: [...new Set([...normalizedSet(x.dependencies), ...normalizedSet(y.dependencies)])] };
  }
  return out;
}

async function llmClassifySmartFields(
  fields: Array<{ name: string; instruction: string }>,
  userId?: string,
): Promise<Record<string, SmartFieldClassification>> {
  if (fields.length === 0) return {};
  const { FIELD_GROUPS, CARD_REVENUE_GROUP } = await import('./enrichmentGroups');
  const {
    buildSmartFieldClassificationSystemPrompt,
    buildSmartFieldClassificationUserPrompt,
  } = await import('./enrichmentPrompts');

  // Enigma card revenue excluded for the same reason as in llmInferAliases.
  const canonicalFieldList = Object.entries(FIELD_GROUPS)
    .filter(([group]) => group !== CARD_REVENUE_GROUP)
    .map(([group, cfg]) => `  ${group}: ${cfg.fields.join(', ')}`)
    .join('\n');

  try {
    const { createEnrichmentHelperLLM } = await import('./enrichmentMappingLlm');
    const llm = await createEnrichmentHelperLLM(userId, process.env.CRM_ENRICH_V3_CLASSIFY_MODEL || process.env.CRM_ENRICH_V3_ALIAS_MODEL);
    const classifyOnce = () => llm.generateJSONContent<Record<string, SmartFieldClassification>>(
      buildSmartFieldClassificationSystemPrompt(canonicalFieldList),
      buildSmartFieldClassificationUserPrompt(fields),
      'json',
      undefined,
      enrichmentConfigUsageContext(userId),
    );
    // ENG-2720: the answer is saved on the list and decides how every later run treats the field, and
    // the model is not deterministic. Ask twice in parallel and keep only what both samples agree on;
    // a field they disagree on stays unclassified and is asked again at the next save.
    const [first, second] = await Promise.allSettled([classifyOnce(), classifyOnce()]);
    if (first.status !== 'fulfilled' || second.status !== 'fulfilled') {
      const failed = first.status === 'rejected' ? first.reason : (second as PromiseRejectedResult).reason;
      throw failed instanceof Error ? failed : new Error(String(failed));
    }
    const agreed = agreeingClassifications(first.value ?? {}, second.value ?? {});
    const answered = first.value && typeof first.value === 'object' ? Object.keys(first.value) : [];
    const dropped = answered.filter(name => !(name in agreed)).length;
    if (dropped > 0) console.warn(`[enrichmentConfigDeps] smart-field classification: ${dropped} field(s) not saved, the two samples disagreed`);
    return agreed;
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
    mergeListFieldNames: async (listId, fieldNames) => {
      // Append only names not already present (getLeadListById dedupes on
      // read), so calling this on every config save is idempotent.
      const list = await crmDb.getLeadListById(listId);
      const existing = new Set(Array.isArray(list?.fieldNames) ? (list!.fieldNames as string[]) : []);
      const trulyNew = fieldNames.filter((n) => !existing.has(n));
      if (trulyNew.length > 0) await crmDb.mergeFieldNames(listId, trulyNew);
    },
    llmSuggestTypes: async (fields) => heuristicTypeSuggestion(fields),
    llmInferAliases,
    llmClassifySmartFields,
  };
}

/** Processing-only deps — no writeListConfig. Used by Emma's in-memory path. */
export function buildConfigProcessingDeps(): ConfigProcessingDeps {
  return {
    readListConfig: (listId) => crmDb.getEnrichmentConfig(listId),
    llmInferAliases,
    llmClassifySmartFields,
  };
}
