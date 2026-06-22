/**
 * llmPricing — single source of truth for LLM list prices (Ship 1: shadow metering).
 *
 * All prices are USD per 1M tokens. Cache pricing convention (matches the existing
 * estimateCost() in agentModeService.ts): cache reads = 10% of input price, cache
 * writes = 125% of input price, unless a provider publishes explicit cache rates.
 *
 * Coverage contract: EVERY model id in agentModeService's `llmModels` registry MUST
 * have an entry here. The registry-coverage unit test in
 * `__tests__/llmPricing.test.ts` is the CI guard for this.
 *
 * IMPORTANT: getModelPrice() returns null for unknown models — there is deliberately
 * NO silent fallback to another model's price (the old estimateCost defaulted unknown
 * models to Sonnet pricing, which hides pricing gaps).
 */

export interface ModelPrice {
  /** USD per 1M input tokens */
  inPerM: number;
  /** USD per 1M output tokens */
  outPerM: number;
  /** USD per 1M cache-read tokens (defaults to 10% of inPerM when omitted) */
  cacheReadPerM?: number;
  /** USD per 1M cache-write tokens (defaults to 125% of inPerM when omitted) */
  cacheWritePerM?: number;
}

/** Derive the conventional cache prices from an input price. */
function withDerivedCache(inPerM: number, outPerM: number): ModelPrice {
  return {
    inPerM,
    outPerM,
    cacheReadPerM: inPerM * 0.1,
    cacheWritePerM: inPerM * 1.25,
  };
}

/**
 * Token-priced models. Sources:
 * - Ported from agentModeService.estimateCost() where present.
 * - Models missing there were researched against current public list prices
 *   (June 2026); anything that could not be confirmed against an official
 *   price page is tagged with `// UNVERIFIED`.
 */
export const MODEL_PRICING: Record<string, ModelPrice> = {
  // ── AWS Bedrock Anthropic (ported from estimateCost) ───────────────────────
  'anthropic.claude-sonnet-4-5-20250929-v1:0': withDerivedCache(3, 15),
  'anthropic.claude-sonnet-4-6': withDerivedCache(3, 15),
  'anthropic.claude-opus-4-6-v1': withDerivedCache(15, 75),
  'anthropic.claude-opus-4-8': withDerivedCache(15, 75),

  // ── Azure OpenAI chat deployments ───────────────────────────────────────────
  'gpt-5-chat-2': withDerivedCache(2.5, 10), // ported from estimateCost
  'gpt-5.2-chat': withDerivedCache(3, 12), // ported from estimateCost
  'gpt-5.4': withDerivedCache(2.5, 10), // input $2.50/M per public listings; output UNVERIFIED (estimated at 4x input, matching gpt-5-chat-2 ratio)
  'gpt-5.4-nano': withDerivedCache(0.2, 1.25), // per public listings (pricepertoken/gptbreeze, Jun 2026)
  'gpt-5.5': withDerivedCache(5, 30), // OpenAI direct list price; UNVERIFIED for Azure deployments (Azure rate may differ)

  // ── Google Gemini ────────────────────────────────────────────────────────────
  'gemini-3-pro-preview': withDerivedCache(1.25, 10), // ported from estimateCost
  'gemini-3-flash-preview': withDerivedCache(0.15, 0.6), // ported from estimateCost
  'gemini-3.1-pro-preview': withDerivedCache(1.25, 10), // ported from estimateCost
  'gemini-3.1-flash-lite': withDerivedCache(0.075, 0.3), // ported from estimateCost
  'gemini-3.5-flash': withDerivedCache(0.15, 0.6), // ported from estimateCost
  'gemini-3.1-flash-live-preview': withDerivedCache(0.75, 4.5), // text rate per public listings (cloudprice, Jun 2026); UNVERIFIED — audio/video tokens are billed at higher live-API rates not modeled here

  // ── Chatbot (Emma) Azure deployments ────────────────────────────────────────
  // NOTE: chatbotService.calculateCost() carries per-1K rates that are 10x the
  // published Azure list prices (likely a long-standing bug). The shadow price
  // book uses the official list prices instead — the comparison endpoint is
  // expected to surface this discrepancy.
  'gpt-4o': withDerivedCache(2.5, 10),
  'gpt-4.1': withDerivedCache(2, 8),
  'gpt-4': withDerivedCache(30, 60), // legacy default deployment name; official GPT-4 8k list price

  // ── Embeddings (output side is always 0 — embeddings have no completion) ────
  'text-embedding-3-large': { inPerM: 0.13, outPerM: 0 },
  'text-embedding-3-small': { inPerM: 0.02, outPerM: 0 },
  'text-embedding-ada-002': { inPerM: 0.1, outPerM: 0 },
};

/**
 * Image generation models — fixed USD per generated image (not token priced).
 * Ported from agentModeService.estimateImageGenerationCost().
 */
export const IMAGE_GENERATION_PRICING_USD: Record<string, number> = {
  'gpt-image-1': 0.04,
  'gpt-image-2': 0.04,
  'gemini-2.5-flash-image': 0.039,
  'gemini-3-pro-image-preview': 0.039,
  'gemini-3.1-flash-image': 0.039,
  // Legacy preview id kept so historical usage records still price correctly.
  'gemini-3.1-flash-image-preview': 0.039,
  'gen4_image': 0.05,
  'gemini_2.5_flash': 0.04,
};

/**
 * Video generation models — USD per 8s clip (longer videos bill as multiple clips).
 * Ported from agentModeService.estimateVideoGenerationCost().
 */
export const VIDEO_GENERATION_PRICING_USD_PER_CLIP: Record<string, number> = {
  'veo-3.1-generate-preview': 2.8,
  'veo-3.1-fast-generate-preview': 1.4,
};

/** Models we've already warned about this process — dedupes the unknown-model warn. */
const warnedUnknownModels = new Set<string>();

/**
 * Look up the token price for a model.
 *
 * Returns null for unknown models and emits a single console.warn per model per
 * process. Callers MUST treat null as "cost unknown" (record cost 0) — never
 * substitute another model's price.
 */
export function getModelPrice(model: string): ModelPrice | null {
  const price = MODEL_PRICING[model];
  if (price) return price;

  if (!warnedUnknownModels.has(model)) {
    warnedUnknownModels.add(model);
    console.warn(
      `[llmPricing] No price entry for model "${model}" — usage will be recorded with cost 0. ` +
        `Add it to MODEL_PRICING in src/utils/llmPricing.ts.`
    );
  }
  return null;
}

/** Test hook: reset the warn dedup set. */
export function __resetUnknownModelWarnsForTests(): void {
  warnedUnknownModels.clear();
}
