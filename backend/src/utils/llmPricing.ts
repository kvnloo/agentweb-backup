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

// Fable 5 / Haiku 4.5 list prices, confirmed against Anthropic's official pricing
// (Fable $10/$50, Haiku $1/$5). Defined once and registered under BOTH the bare
// Vertex id (e.g. claude-fable-5) and the anthropic.-prefixed Bedrock id, because
// the registry key ENG-199 uses depends on the provider it wires Fable through
// (Vertex → bare, Bedrock → anthropic.<id>). Same object reference on both keys so
// the two can never drift. Without the prefixed key, a Bedrock rollout would miss
// the lookup and record $0 — the exact blind spot ENG-200 exists to close.
const FABLE_5_PRICE = withDerivedCache(10, 50);
const HAIKU_4_5_PRICE = withDerivedCache(1, 5);

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
  // the moment ENG-199 wires it into the registry, under whichever provider id it
  // ends up invoked as (Vertex bare or Bedrock anthropic.-prefixed — see above).
  'claude-fable-5': FABLE_5_PRICE,
  'anthropic.claude-fable-5': FABLE_5_PRICE,
  'claude-haiku-4-5': HAIKU_4_5_PRICE,
  'anthropic.claude-haiku-4-5': HAIKU_4_5_PRICE,

  // ── Azure OpenAI chat deployments ───────────────────────────────────────────
  'gpt-5-chat-2': withDerivedCache(2.5, 10), // ported from estimateCost
  'gpt-5.2-chat': withDerivedCache(1.75, 14), // developers.openai.com/api/docs/models/gpt-5.2
  'gpt-5.4': withDerivedCache(2.5, 15), // developers.openai.com/api/docs/pricing
  'gpt-5.4-nano': withDerivedCache(0.2, 1.25), // per public listings (pricepertoken/gptbreeze, Jun 2026)
  'gpt-5.5': withDerivedCache(5, 30), // $5/$30 in/out + $0.50/1M cached — developers.openai.com/api/docs/pricing (Apr 23 2026 GPT-5-line price doubling); cache-read derives to $0.50, matching the published rate

  // ── Google Gemini ────────────────────────────────────────────────────────────
  // All Gemini rates verified against ai.google.dev/gemini-api/docs/pricing (Jul 2026).
  // Standard (≤200K prompt) rates; gemini-3.1-pro doubles above 200K (not modeled here).
  'gemini-3-pro-preview': withDerivedCache(1.25, 10), // DEPRECATED 2026-03-09 (migrate to 3.1-pro); rate left as last-known
  'gemini-3-flash-preview': withDerivedCache(0.5, 3), // was 0.15/0.6 — stale
  'gemini-3.1-pro-preview': withDerivedCache(2, 12), // was 1.25/10 — stale
  'gemini-3.1-flash-lite': withDerivedCache(0.25, 1.5), // was 0.075/0.3 — stale
  'gemini-3.5-flash': withDerivedCache(1.5, 9), // was 0.15/0.6 — stale
  'gemini-2.5-flash': withDerivedCache(0.3, 2.5), // text/chat model — was MISSING (recorded $0)
  'gemini-3.1-flash-live-preview': withDerivedCache(0.75, 4.5), // $0.75/$4.50 text tokens — verified (langcopilot/cloudprice, 2026). SCOPE: audio/video tokens on the Live API bill at higher per-modality rates not modeled here; this is the text-token approximation used for cost metering.
  // Deep Research agents (Gemini) report usage via usageMetadata and run on
  // Gemini 3.1 Pro token rates: $2/1M in, $12/1M out (tokencost.app, Jul 2026;
  // matches gemini-3.1-pro-preview above). Per-task Google Search grounding is
  // billed separately at a per-query rate — not a per-token cost, so not modeled here.
  'deep-research-preview-04-2026': withDerivedCache(2, 12),
  'deep-research-max-preview-04-2026': withDerivedCache(2, 12), // same per-token rate as standard; Max differs in task depth / search volume, not token price

  // ── Chatbot (Emma) Azure deployments ────────────────────────────────────────
  // NOTE: chatbotService.calculateCost() carries per-1K rates that are 10x the
  // published Azure list prices (likely a long-standing bug). The shadow price
  // book uses the official list prices instead — the comparison endpoint is
  // expected to surface this discrepancy.
  // OpenAI publishes gpt-4o cached input at $1.25/1M (50% of the $2.50 input rate),
  // not the 10%-of-input default our convention would derive ($0.25). Override the
  // cache-read rate with the real published number; write stays on the convention.
  'gpt-4o': { ...withDerivedCache(2.5, 10), cacheReadPerM: 1.25 },
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
  // Seedance 2.0: effective Higgsfield rate for a 720p 8s standard clip = $1.55
  // (Higgsfield's own published per-clip cost, higgsfield.ai/blog/seedance-2-0-pricing-2026;
  // cross-checked ~40 credits/clip x $0.039/credit on the Plus plan = $1.56). Our path is
  // Higgsfield MCP, so this beats the fal.ai proxy ($2.43). Fast mode would be $1.20.
  'seedance-2.0': 1.55,
};

/**
 * Per-generation USD cost for an image model (billed per image, not per token).
 * Single source of truth for image cost — used by the generation source meter and
 * agent-mode session accounting alike.
 */
export function imageGenerationCostUsd(model: string): number {
  return IMAGE_GENERATION_PRICING_USD[model] ?? 0.04;
}

/**
 * Per-generation USD cost for a video model. Video is billed per 8s clip; a longer
 * requested duration bills as ceil(seconds / 8) clips.
 */
export function videoGenerationCostUsd(model: string, durationSeconds?: number): number {
  const clipPrice = VIDEO_GENERATION_PRICING_USD_PER_CLIP[model] ?? 3.2;
  const VEO_MAX_SECONDS = 8;
  const clipCount =
    durationSeconds && durationSeconds > VEO_MAX_SECONDS
      ? Math.ceil(durationSeconds / VEO_MAX_SECONDS)
      : 1;
  return clipPrice * clipCount;
}

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
