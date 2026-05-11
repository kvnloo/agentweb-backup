/**
 * LLM-backed extractor: ICPPersona → up to 3 candidate LinkedIn filter
 * variants.
 *
 * The route layer (`GET /api/crm/icp/filters`) calls this on cache miss
 * and persists the result back onto `user.icpResult[i].extractedFilters`.
 * No regex fallback — failures bubble up to the route and surface to the
 * user as 503.
 *
 * Why "variants" plural: a single persona can be searched on LinkedIn
 * through more than one reasonable angle (e.g., broad title-only vs.
 * narrow title+industry+location). Returning 2-3 variants lets the UI
 * offer a picker so the user keeps agency over recall vs. precision.
 */

import { createHash } from 'crypto';
import { LLMService } from '../utils/llmService';
import type { ICPPersona } from './icpStatusService';

/**
 * Bump this when the system prompt, model, or output schema changes.
 * The route uses it together with the persona content hash to invalidate
 * cached filters on `user.icpResult[i].extractedFilters`.
 */
export const ICP_FILTER_CACHE_VERSION = 1;

const FILTER_MODEL = 'anthropic.claude-sonnet-4-6';
const FILTER_TEMPERATURE = 0.2;
const FILTER_MAX_TOKENS = 800;

const MAX_VARIANTS = 3;
const MAX_LABEL_LEN = 40;
const MAX_FIELD_LEN = 200;

export interface FilterVariant {
  label: string;
  title?: string;
  industry?: string;
  location?: string;
  keywords?: string;
}

interface LlmResponse {
  variants: Array<Partial<FilterVariant>>;
}

const SYSTEM_PROMPT = [
  'You are a B2B prospecting assistant that converts a buyer persona into LinkedIn People-search filters.',
  '',
  'Given one ICP persona (name + pain + desire + objection + meta_targeting_brief), produce 1 to 3 distinct candidate filter sets. Return MORE THAN ONE only when the persona admits more than one reasonable angle (e.g., broad vs. narrow, region A vs. region B, role-focused vs. industry-focused). When the persona is unambiguous, return exactly one variant.',
  '',
  'For each variant, fill in only the fields you are confident about. Empty / unknown fields must be omitted. The fields are:',
  '  - title      LinkedIn "Title" filter. Concrete role + seniority (e.g., "VP Marketing", "RevOps Leader"). Avoid commas / boolean operators.',
  '  - industry   LinkedIn industry token (e.g., "SaaS", "FinTech", "B2B SaaS", "HealthTech").',
  '  - location   A LinkedIn geographic filter (e.g., "United States", "North America", "London"). Skip when the persona is global.',
  '  - keywords   ONLY use this when no good title is extractable. Single line, no punctuation other than spaces. Do not put prose here — LinkedIn ANDs every word, so long sentences kill recall.',
  '',
  'Each variant also needs a short "label" (<= 40 chars) describing its angle, e.g., "Broad", "Enterprise NA", "EU FinTech".',
  '',
  'OUTPUT CONTRACT — return ONLY valid JSON matching this exact shape (no prose preamble, no markdown fence):',
  '{',
  '  "variants": [',
  '    { "label": "Broad", "title": "...", "industry": "...", "location": "...", "keywords": "..." }',
  '  ]',
  '}',
  '',
  'Constraints:',
  '  - 1 <= variants.length <= 3',
  '  - Every variant must have a non-empty label AND at least one of {title, industry, location, keywords} filled.',
  '  - Never invent locations / industries the persona text does not justify.',
].join('\n');

function buildUserPrompt(p: ICPPersona): string {
  return [
    'Persona to convert:',
    `- name: ${p.name ?? ''}`,
    `- pain: ${p.pain ?? ''}`,
    `- desire: ${p.desire ?? ''}`,
    `- objection: ${p.objection ?? ''}`,
    `- meta_targeting_brief: ${p.meta_targeting_brief ?? ''}`,
    '',
    'Return JSON matching the schema in the system prompt.',
  ].join('\n');
}

function coerceField(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_FIELD_LEN ? trimmed.slice(0, MAX_FIELD_LEN) : trimmed;
}

function sanitizeVariant(v: Partial<FilterVariant>): FilterVariant | null {
  const labelRaw = typeof v.label === 'string' ? v.label.trim() : '';
  if (!labelRaw) return null;
  const label = labelRaw.length > MAX_LABEL_LEN ? labelRaw.slice(0, MAX_LABEL_LEN) : labelRaw;
  const title = coerceField(v.title);
  const industry = coerceField(v.industry);
  const location = coerceField(v.location);
  const keywords = coerceField(v.keywords);
  if (!title && !industry && !location && !keywords) return null;
  return { label, title, industry, location, keywords };
}

/**
 * Pure LLM call. The `deps.llm` injection point exists so unit tests
 * can stub the model without touching Bedrock.
 */
export async function extractIcpFiltersWithLlm(
  persona: ICPPersona,
  deps: { llm?: { generateJsonRobust: LLMService['generateJsonRobust'] } } = {},
): Promise<FilterVariant[]> {
  const llm =
    deps.llm ?? new LLMService(FILTER_MODEL, FILTER_TEMPERATURE, FILTER_MAX_TOKENS);
  const raw = await llm.generateJsonRobust<LlmResponse>(SYSTEM_PROMPT, buildUserPrompt(persona));
  if (!raw || !Array.isArray((raw as LlmResponse).variants)) {
    throw new Error('LLM returned malformed response: missing variants array');
  }
  const cleaned: FilterVariant[] = [];
  for (const v of raw.variants) {
    if (cleaned.length >= MAX_VARIANTS) break;
    const sanitised = sanitizeVariant(v ?? {});
    if (sanitised) cleaned.push(sanitised);
  }
  if (cleaned.length === 0) {
    throw new Error('LLM returned no usable variants');
  }
  return cleaned;
}

/**
 * Stable hash of the persona fields the LLM sees. Used by the route to
 * decide whether a previously cached `extractedFilters` is still valid
 * for the current persona content.
 *
 * Plain SHA-256 of the same delimited payload the prompt builds; if you
 * change which fields the LLM consumes, change this too AND bump
 * `ICP_FILTER_CACHE_VERSION`.
 */
export function personaCacheKey(persona: ICPPersona): string {
  const payload = [
    persona.name ?? '',
    persona.pain ?? '',
    persona.desire ?? '',
    persona.objection ?? '',
    persona.meta_targeting_brief ?? '',
  ].join('␟'); // unit-separator-ish glyph to avoid accidental collisions
  return createHash('sha256').update(payload).digest('hex');
}
