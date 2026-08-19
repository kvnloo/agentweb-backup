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
 * Cache-write price as a multiple of the input rate, per prompt-cache TTL.
 * Anthropic's published multipliers: 5-minute writes 1.25x, 1-hour writes 2x.
 */
export const CACHE_WRITE_TTL_MULTIPLIER: Readonly<Record<string, number>> = Object.freeze({
  '5m': 1.25,
  '1h': 2,
});

/** Cache-write tokens split by the TTL Bedrock actually applied, e.g. `{ '1h': 84210 }`. */
export type CacheWriteByTtl = Readonly<Record<string, number>>;

/**
 * Cost of cache-WRITE tokens for one call, in USD-per-1M units (tokens x rate;
 * divide by 1e6 for dollars, or round for microdollars).
 *
 * ENG-893: Bedrock returns `usage.cacheDetails` — the exact token count per TTL
 * it applied. When we have it, bill each bucket at ITS rate rather than at the
 * model's declared rate. That matters because requesting `ttl: '1h'` is not a
 * guarantee of getting it: Bedrock accepts the field on models AWS documents as
 * 5-minute-only (probed live 2026-08-04), so a static 2x rate would over-bill by
 * 60% on any model that silently served us a 5-minute cache. Pricing from what
 * came back makes the ledger correct no matter which TTL was honoured, and means
 * a wrong allowlist entry costs missed savings rather than money.
 *
 * Falls back to the model's declared `cacheWritePerM` when no breakdown is
 * present (non-Bedrock providers, or a response without `cacheDetails`).
 */
export function cacheWriteCost(
  price: ModelPrice,
  cacheWriteTokens: number,
  byTtl?: CacheWriteByTtl
): number {
  const declaredPerM = price.cacheWritePerM ?? price.inPerM * 1.25;
  if (!byTtl) return cacheWriteTokens * declaredPerM;

  let billed = 0;
  let accountedTokens = 0;
  for (const [ttl, tokens] of Object.entries(byTtl)) {
    if (!Number.isFinite(tokens) || tokens <= 0) continue;
    const multiplier = CACHE_WRITE_TTL_MULTIPLIER[ttl];
    // An unrecognised TTL must not be billed at zero — fall back to the
    // declared rate so a new Bedrock TTL tier can never under-bill silently.
    billed += tokens * (multiplier != null ? price.inPerM * multiplier : declaredPerM);
    accountedTokens += tokens;
  }
  // Any remainder the breakdown did not cover still bills at the declared rate.
  const unaccounted = Math.max(0, cacheWriteTokens - accountedTokens);
  return billed + unaccounted * declaredPerM;
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
  // ENG-893: every cacheWritePerM here is the DEFAULT-TTL (1.25x) rate, even
  // for models agent-mode invokes with `ttl: '1h'`. The 1-hour rate is 2x, but
  // it is applied per RESPONSE by cacheWriteCost, not per model — because a
  // model id is shared across paths with different TTLs. Sonnet 4.6 is the
  // proof: agent-mode asks it for 1h, while codingAgentService and rcaEnricher
  // use the same id with no ttl at all. One per-model number cannot be right
  // for both; `usage.cacheDetails` / `usage.cache_creation` can.
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
  // ENG-744 — Claude 5 generation, priced under the exact id the registry
  // invokes so the ENG-693 usage ledger books real cost instead of $0.
  // Rates are Anthropic's published list prices, the same convention every
  // Bedrock Anthropic row above already uses (Opus 4.8 = $5/$25 here too).
  'anthropic.claude-opus-5': withDerivedCache(5, 25),
  // Sonnet 5 standard rate. Anthropic also runs a $2/$10 introductory rate
  // through 2026-08-31, but that is first-party-API only and temporary —
  // metering at the standard rate cannot under-bill when it lapses.
  'anthropic.claude-sonnet-5': withDerivedCache(3, 15),
  // The bare 'anthropic.claude-haiku-4-5' key above does NOT cover this id:
  // canonicalModelId strips only a trailing bare -YYYY-MM-DD, and this one ends
  // in '-20251001-v1:0'. Without its own key the lookup misses and records $0.
  'anthropic.claude-haiku-4-5-20251001-v1:0': HAIKU_4_5_PRICE,

  // ── Azure OpenAI chat deployments ───────────────────────────────────────────
  // gpt-5-chat-2 and gpt-5.2-chat pricing entries REMOVED 2026-08-19 along with
  // their agentModeService registry rows (see the comment there) — both ids now
  // resolve through LEGACY_MODEL_ALIASES to gpt-5.5 before any pricing lookup,
  // so these entries were unreachable dead weight.
  'gpt-5.4': withDerivedCache(2.5, 15), // developers.openai.com/api/docs/pricing
  'gpt-5.4-nano': withDerivedCache(0.2, 1.25), // per public listings (pricepertoken/gptbreeze, Jun 2026)
  'gpt-5.5': withDerivedCache(5, 30), // $5/$30 in/out + $0.50/1M cached — developers.openai.com/api/docs/pricing (Apr 23 2026 GPT-5-line price doubling); cache-read derives to $0.50, matching the published rate

  // ── Google Gemini ────────────────────────────────────────────────────────────
  // All Gemini rates verified against ai.google.dev/gemini-api/docs/pricing (Jul 2026).
  // Standard (≤200K prompt) rates; gemini-3.1-pro doubles above 200K (not modeled here).
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
  // OpenAI publishes gpt-4o cached input at $1.25/1M (50% of the $2.50 input rate),
  // not the 10%-of-input default our convention would derive ($0.25). Override the
  // cache-read rate with the real published number; write stays on the convention.
  'gpt-4o': { ...withDerivedCache(2.5, 10), cacheReadPerM: 1.25 },
  'gpt-4.1': withDerivedCache(2, 8),
  'gpt-4': withDerivedCache(30, 60), // legacy default deployment name; official GPT-4 8k list price

  // ── OpenRouter (ENG-9) ───────────────────────────────────────────────────────
  // Static fallback/estimate only — the real per-call cost comes from OpenRouter's
  // `usage.cost` and is forwarded as a costUsdOverride at call time (ENG-9 AC #6),
  // so these entries exist to satisfy modelPricingCoverage.test.ts (no model may be
  // priced at $0/free-by-omission) and to render an estimate before a call completes.
  // Rates per openrouter.ai/models list pricing, Aug 2026.
  'openrouter/openai/gpt-4o-mini': withDerivedCache(0.15, 0.6),
  // 2026-08-19: every entry below this line was re-verified live against
  // each model's own openrouter.ai page (top-of-page "In / Out Price" stat,
  // cross-checked against the page's FAQ sentence) after a routine
  // cross-check caught real drift — 10 of 12 didn't match this file, ranging
  // from minor (~1.1-1.3x) to kimi-k3's 4.8x miss (this file had it at
  // $0.60/$2.50; live is $2.60/$13.00 — the model is a frontier-tier price,
  // not a budget one). These are OpenRouter's STANDARD (non-BYOK) prices —
  // BYOK would only be cheaper if we held our own key for that specific
  // provider, which we don't for any of these. Where OpenRouter's page shows
  // an active "% off" promo badge, the live promotional rate is recorded
  // (it's what actually gets billed today) with a note — a promo can lapse,
  // so these are the ones most likely to need re-verifying again later.
  // BYOK-routed to our own Azure resource (agentweb-openrouter-byok, westus3, confirmed
  // live 2026-08-19 with gpt-5.6-sol/terra/luna deployed & Running). OpenRouter's own
  // marketplace promo pricing does NOT apply to BYOK traffic — we're billed Azure's real
  // GlobalStandard list rate. Prices below = Azure's official "Global", short-context
  // GPT-5.6 Series rate (azure.microsoft.com/pricing/details/cognitive-services/azure-openai),
  // verified live 2026-08-19. (Cached/write rates already match our 10%/125% derived-cache
  // convention exactly against Azure's own published cache rates for all three.)
  'openrouter/openai/gpt-5.6-sol': withDerivedCache(5.0, 30.0),
  'openrouter/openai/gpt-5.6-terra': withDerivedCache(2.5, 15.0),
  'openrouter/openai/gpt-5.6-luna': withDerivedCache(1.0, 6.0),
  'openrouter/x-ai/grok-4.6': withDerivedCache(2.0, 6.0), // was $3/$15 — stale, ~2x over live
  'openrouter/deepseek/deepseek-v4-pro': withDerivedCache(0.657, 1.315), // live "62% off" promo; lowest-confidence entry in this batch — the promo makes list price hard to reconstruct cleanly, re-verify if this model becomes cost-sensitive
  'openrouter/deepseek/deepseek-v4-flash': withDerivedCache(0.068, 0.168), // was ~2x over live
  'openrouter/qwen/qwen3.8-max': withDerivedCache(2.0, 6.0),
  'openrouter/mistralai/mistral-small-2603': withDerivedCache(0.15, 0.6),
  'openrouter/moonshotai/kimi-k3': withDerivedCache(2.6, 13.0), // was $0.60/$2.50 — 4.8x under live; this is a frontier-tier model, not budget
  'openrouter/moonshotai/kimi-k2.7-code': withDerivedCache(0.67, 3.4),
  'openrouter/z-ai/glm-5.2': withDerivedCache(0.42, 1.32), // live "70% off" promo vs list
  'openrouter/z-ai/glm-4.7-flash': withDerivedCache(0.06, 0.4),

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
 * Rolling-alias model ids that providers return in `response.model` but that are
 * NOT literal registry keys. Azure/OpenAI report a rolling alias for some
 * deployments, so without this map that usage meters at $0. Map alias → canonical
 * registry key. Empty as of 2026-08-19 — its one entry ('gpt-chat-latest' for the
 * since-removed gpt-5-chat-2 deployment) was removed along with that deployment;
 * left as live infrastructure for the next deployment that needs it.
 */
const MODEL_ID_ALIASES: Record<string, string> = {};

/** Trailing dated-snapshot suffix, e.g. "-2025-04-14" on "gpt-4.1-2025-04-14". */
const DATE_SNAPSHOT_SUFFIX = /-\d{4}-\d{2}-\d{2}$/;

/**
 * Collapse a provider-returned model id to its canonical pricing key. Handles the
 * two ways Azure/OpenAI `response.model` drifts from the deployment/registry name:
 * a rolling alias (MODEL_ID_ALIASES) or a dated snapshot suffix
 * ("gpt-4.1-2025-04-14" → "gpt-4.1"). Returns the input unchanged when neither
 * applies — so an unknown model stays unknown (never a false price match).
 */
function canonicalModelId(model: string): string {
  // Defensive: recordUsage may call getModelPrice with a missing/empty model
  // (typed string, but undefined at runtime) — return it unchanged, never throw.
  if (typeof model !== 'string' || !model) return model;
  if (MODEL_ID_ALIASES[model]) return MODEL_ID_ALIASES[model];
  const stripped = model.replace(DATE_SNAPSHOT_SUFFIX, '');
  if (stripped !== model && MODEL_ID_ALIASES[stripped]) return MODEL_ID_ALIASES[stripped];
  return stripped;
}

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

  // Normalize provider-returned `response.model` drift (rolling aliases + dated
  // snapshot suffixes) to the canonical registry key before giving up. This is
  // not "substitute another model's price" — it resolves the SAME model reported
  // under a non-canonical id (e.g. "gpt-4.1-2025-04-14" → "gpt-4.1"), which would
  // otherwise meter at $0.
  const canonical = canonicalModelId(model);
  if (canonical !== model) {
    const canonicalPrice = MODEL_PRICING[canonical];
    if (canonicalPrice) return canonicalPrice;
  }

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

/**
 * 0-100 relative cost score for the model picker's cost meter, higher = more
 * expensive. Blend = 75% input + 25% output (approximates a typical agent-mode
 * workload's token mix), placed on a log scale anchored to a fixed $0.05-$100
 * per-1M-blended-token range so real-world pricing spreads meaningfully across
 * the scale instead of bunching near 0.
 *
 * Deliberately computed from MODEL_PRICING (via getModelPrice) rather than
 * stored as a separate hand-typed number per model — two independent numbers
 * claiming to represent "the same model's real cost" WILL drift (11 of 29
 * hand-typed scores had already gone stale relative to MODEL_PRICING by
 * 2026-08-19, caught by exactly this kind of cross-check). Deriving it live
 * means the picker's cost meter can never disagree with what we actually bill.
 */
export function costScoreFromPrice(price: ModelPrice): number {
  const blended = 0.75 * price.inPerM + 0.25 * price.outPerM;
  const FLOOR_USD_PER_M = 0.05;
  const CEILING_USD_PER_M = 100;
  const frac =
    (Math.log10(blended) - Math.log10(FLOOR_USD_PER_M)) /
    (Math.log10(CEILING_USD_PER_M) - Math.log10(FLOOR_USD_PER_M));
  return Math.round(100 * Math.max(0, Math.min(1, frac)));
}
