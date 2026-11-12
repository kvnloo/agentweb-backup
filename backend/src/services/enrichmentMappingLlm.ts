// ENG-2720: the small LLM calls around an enrichment run (field alias inference, smart-field
// classification, sibling field mapping) used to default to "gpt-5-chat-2", a retired id that callLLM
// rewrites to gpt-5.5 (about 25x Luna's token price), while the extraction itself ran on the cheap
// default. They now resolve the same "enrichment" role as every other enrichment call, so one default
// (and an org's own override) covers the whole pipeline.
import { createLLMService } from '../utils/llmService';
import { resolveModelForUser } from './modelRoles';

export const CHEAP_DEFAULT_MODEL = 'openrouter/openai/gpt-5.6-luna';
export const FALLBACK_MODEL = 'gpt-5.5';

/**
 * LLM for an enrichment helper call: `envModel` (a CRM_ENRICH_V3_* override, kept for compatibility)
 * wins, else the user's enrichment role. An empty 200 is retried, and the cheap default falls back to
 * gpt-5.5 on a provider error, as for the extraction calls.
 */
export async function createEnrichmentHelperLLM(userId: string | undefined, envModel?: string) {
  const model = envModel || await resolveModelForUser(userId, 'enrichment');
  return createLLMService(model, 0.0, undefined, {
    requireContent: true,
    ...(model === CHEAP_DEFAULT_MODEL ? { fallbackModels: [FALLBACK_MODEL] } : {}),
  });
}
