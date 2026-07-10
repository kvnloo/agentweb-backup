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
  'anthropic.claude-opus-4-6-v1': withDerivedCache(5, 25),
  'anthropic.claude-opus-4-8': withDerivedCache(5, 25),
  // Anthropic dropped Opus to $5/$25 at the 4.5 generation; the old $15/$75 rate
  // above was stale (ported from estimateCost) and overcharged the cost cap 3x.
  // Fable 5 is ENG-200's target model — staged here so the cost cap is accurate
  // the moment ENG-199 wires it into the registry (confirm the exact invoked id).
  'claude-fable-5': withDerivedCache(10, 50),
  'claude-haiku-4-5': withDerivedCache(1, 5),

  // ── Azure OpenAI chat deployments ───────────────────────────────────────────
  'gpt-5-chat-2': withDerivedCache(2.5, 10), // ported from estimateCost
  'gpt-5.2-chat': withDerivedCache(1.75, 14), // developers.openai.com/api/docs/models/gpt-5.2
  'gpt-5.4': withDerivedCache(2.5, 15), // developers.openai.com/api/docs/pricing
  'gpt-5.4-nano': withDerivedCache(0.2, 1.25), // per public listings (pricepertoken/gptbreeze, Jun 2026)
  'gpt-5.5': withDerivedCache(5, 30), // OpenAI direct list price; UNVERIFIED for Azure deployments (Azure rate may differ)

  // ── Google Gemini ────────────────────────────────────────────────────────────
  // All Gemini rates verified against ai.google.dev/gemini-api/docs/pricing (Jul 2026).
  // Standard (≤200K prompt) rates; gemini-3.1-pro doubles above 200K (not modeled here).
  'gemini-3-pro-preview': withDerivedCache(1.25, 10), // DEPRECATED 2026-03-09 (migrate to 3.1-pro); rate left as last-known
  'gemini-3-flash-preview': withDerivedCache(0.5, 3), // was 0.15/0.6 — stale
  'gemini-3.1-pro-preview': withDerivedCache(2, 12), // was 1.25/10 — stale
  'gemini-3.1-flash-lite': withDerivedCache(0.25, 1.5), // was 0.075/0.3 — stale
  'gemini-3.5-flash': withDerivedCache(1.5, 9), // was 0.15/0.6 — stale
  'gemini-2.5-flash': withDerivedCache(0.3, 2.5), // text/chat model — was MISSING (recorded $0)
  'gemini-3.1-flash-live-preview': withDerivedCache(0.75, 4.5), // text rate per public listings (cloudprice, Jun 2026); UNVERIFIED — audio/video tokens are billed at higher live-API rates not modeled here
  // Deep Research agents report token usage via usageMetadata; priced at Gemini
  // Pro token rates as a best-effort estimate. UNVERIFIED — Google has not
  // published per-token rates for the deep-research agents (ENG-207 to confirm).
  'deep-research-preview-04-2026': withDerivedCache(1.25, 10), // UNVERIFIED
  'deep-research-max-preview-04-2026': withDerivedCache(1.25, 10), // UNVERIFIED

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
  'gemini-3-pro-image-preview': 0.134, // Pro ("Nano Banana Pro") standard-tier; was mispriced at flash-tier 0.039 (ai.google.dev)
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
  'veo-3.1-generate-preview': 3.2, // $0.40/s x 8s, audio incl. (ai.google.dev); was 2.8
  'veo-3.1-fast-generate-preview': 1.4, // within official fast range ($0.10-0.30/s)
  'veo-3-generate-preview': 3.2, // $0.40/s x 8s (ai.google.dev); was unpriced -> recorded $0
  // Higgsfield Seedance publishes no official USD/sec — credit-derived ~$2.24-2.80/8s.
  // Kept at the code's long-standing 0.50 pending a real billed-Higgsfield rate (UNVERIFIED).
  'seedance-2.0': 0.5,
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

  // Image and video models are intentionally NOT token-priced — they are billed
  // per-image / per-clip via IMAGE_GENERATION_PRICING_USD and
  // VIDEO_GENERATION_PRICING_USD_PER_CLIP. The shadow token recorder still calls
  // getModelPrice for them (the metered client records token usage on every
  // call), so treat them as a known "no token price" case (cost 0) rather than
  // warning about a missing entry.
  if (model in IMAGE_GENERATION_PRICING_USD || model in VIDEO_GENERATION_PRICING_USD_PER_CLIP) {
    return null;
  }

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
