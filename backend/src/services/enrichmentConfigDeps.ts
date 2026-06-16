// Real DynamoDB + LLM dependency implementations for the enrichment config
// service. Extracted from routes/crm.ts so both the CRM routes and Emma's
// enrichment tools build the deps the same way (DRY).

import { crmDb } from './db';
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

async function llmInferAliases(
  fields: Array<{ name: string; instruction: string }>,
): Promise<Record<string, string | null>> {
  if (fields.length === 0) return {};
  // Lazy import — avoids circular deps + keeps the LLM service out of the
  // hot path for callers that never hit alias inference.
  const { FIELD_GROUPS } = await import('./enrichmentGroups');
  const { createLLMService } = await import('../utils/llmService');

  // Build the canonical-field cheat sheet for the system prompt. Grouping
  // by FIELD_GROUPS gives the LLM more context (it understands "Series A"
  // → funding_stage instead of guessing across groups).
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
    // Shadow usage metering (Ship 1): no user in scope here (deps are built
    // without request context), so usage attributes to "system". Follow-up:
    // thread userId through ConfigServiceDeps builders if per-user enrichment
    // attribution is needed.
    const result = await llm.generateJSONContent<Record<string, string | null>>(
      systemPrompt,
      userPrompt,
      'json',
      undefined,
      { feature: 'enrichment' },
    );
    return result ?? {};
  } catch (err) {
    console.warn('[enrichmentConfigDeps] llmInferAliases failed:', (err as Error).message);
    return {};
  }
}

async function llmClassifySmartFields(
  fields: Array<{ name: string; instruction: string }>,
): Promise<Record<string, SmartFieldClassification>> {
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
      Record<string, SmartFieldClassification>
    >(
      buildSmartFieldClassificationSystemPrompt(canonicalFieldList),
      buildSmartFieldClassificationUserPrompt(fields),
      'json',
      undefined,
      { feature: 'enrichment' },
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
  return {
    readListConfig: (listId) => crmDb.getEnrichmentConfig(listId),
    llmInferAliases,
    llmClassifySmartFields,
  };
}
