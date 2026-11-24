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

import { GEMINI_OMNI_VIDEO_MODEL, omniClipDurations } from '../services/videoModels';

/**
 * Version stamp for every price in this file (ENG-1250 §5: "A price change
 * creates a new version; historical events retain the rate version used").
 *
 * Written onto each LLM spend event this book priced (ENG-1934), so a
 * historical event can be re-derived from the prices that produced it. Dated
 * to the last commit that changed a price here.
 *
 * **Bump this in the same commit as any price edit.** `llmPricing.test.ts`
 * pins a fingerprint of the tables to this version, so a price change that
 * forgets the bump fails the build instead of silently sharing a version.
 */
export const LLM_PRICE_BOOK_VERSION = "2026-11-24";

/** The rate provenance a spend event carries when this book priced it. */
export const LLM_PRICE_BOOK_PROVENANCE = `llm-price-book:${LLM_PRICE_BOOK_VERSION}`;

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
// Fable 5.1 (released 2026-09-01): same $10/$50 base rate as Fable 5, but
// Anthropic cut cache-read pricing 75% at this generation ($1.00 -> $0.25 per
// 1M cached input tokens) — confirmed live on openrouter.ai/anthropic/claude-fable-5.1
// (Anthropic-served row) 2026-09-01. withDerivedCache's 10%-of-input convention
// would give $1.00, which is 4x too high for this specific model; the override
// below is required, not optional, or every Fable 5.1 cache-read call
// over-bills 4x. cacheWritePerM is left on the standard 125%-of-input
// convention (Anthropic did not publish a changed write rate).
const FABLE_5_1_PRICE: ModelPrice = { ...withDerivedCache(10, 50), cacheReadPerM: 0.25 };
// Claude Opus 5.5 (released 2026-09-22): Anthropic list $4/$20 per 1M
// in/out (20% below Opus 5), cache-read $0.20/1M (60% below Opus 5,
// openrouter.ai/anthropic/claude-opus-5.5 live 2026-09-22). The 5%-of-input
// read rate breaks withDerivedCache's 10% convention, so it is overridden
// explicitly — same pattern as FABLE_5_1_PRICE above. Write stays on the
// standard 125% convention (Anthropic published no changed write rate).
const OPUS_5_5_PRICE: ModelPrice = { ...withDerivedCache(4, 20), cacheReadPerM: 0.2 };
// Gemini 3.8 Flash (released 2026-09-02): same $0.75/$3.75 base rate as
// Gemini 3.7 Flash, confirmed live on openrouter.ai 2026-09-02. Cache-read
// follows the standard 10%-of-input convention ($0.075/1M — matches live).
// Cache-write does NOT: OpenRouter reports $0.041667/1M live, ~22x lower
// than the derived 125%-of-input rate ($0.9375/1M) — override required or
// every Gemini 3.8 Flash cache-write call overbills ~22x.
const GEMINI_3_8_FLASH_PRICE: ModelPrice = { ...withDerivedCache(0.75, 3.75), cacheWritePerM: 0.041667 };

/**
 * Token-priced models. Sources:
 * - Ported from agentModeService.estimateCost() where present.
 * - Models missing there were researched against current public list prices
 *   (June 2026); anything that could not be confirmed against an official
 *   price page is tagged with `// UNVERIFIED`.
 */
export const MODEL_PRICING: Record<string, ModelPrice> = {
  "openrouter/anthropic/claude-fable-5.2": {"inPerM":8,"outPerM":40,"cacheReadPerM":0.2,"cacheWritePerM":10},
  "openrouter/deepseek/deepseek-v4.1-flash-1017": {"inPerM":0.03,"outPerM":0.2,"cacheReadPerM":0.001},
  "openrouter/google/gemini-4-carbon": {"inPerM":2,"outPerM":10,"cacheReadPerM":0.1,"cacheWritePerM":0.1875},
  "openrouter/google/gemini-4-neon": {"inPerM":3,"outPerM":15,"cacheReadPerM":0.15,"cacheWritePerM":0.0833333333333333},
  "openrouter/openai/gpt-6.1-terra": {"inPerM":1,"outPerM":5,"cacheReadPerM":0.05,"cacheWritePerM":1.25},
  "openrouter/openai/gpt-6.2-astra": {"inPerM":8,"outPerM":40,"cacheReadPerM":0.4,"cacheWritePerM":10},
  "openrouter/openai/gpt-6.2-sol": {"inPerM":2,"outPerM":10,"cacheReadPerM":0.1,"cacheWritePerM":2.5},
  "openrouter/qwen/qwen4-max": {"inPerM":1.425,"outPerM":4.275,"cacheReadPerM":0.07125,"cacheWritePerM":1.78125},

  "openrouter/anthropic/claude-haiku-5.5": {"inPerM":0.1,"outPerM":0.5,"cacheReadPerM":0.01,"cacheWritePerM":0.125},

  // Cache read $0.10/1M per OpenRouter's record (input_cache_read 0.0000001), 5% of input like Opus 5.5 —
  // was $0.20 (the 10% convention), 2x the provider rate. Model-upgrade audit 2026-11-15.
  "openrouter/anthropic/claude-sonnet-5.5": {"inPerM":2,"outPerM":10,"cacheReadPerM":0.1,"cacheWritePerM":2.5},
  "openrouter/deepseek/deepseek-v4-pro-0813": {"inPerM":1.32,"outPerM":3.96,"cacheReadPerM":0.044},
  "openrouter/deepseek/deepseek-v4.1-flash": {"inPerM":0.05,"outPerM":1.2,"cacheReadPerM":0.02},
  "openrouter/google/gemini-3.5-flash-lite": {"inPerM":0.3,"outPerM":2.5,"cacheReadPerM":0.03,"cacheWritePerM":0.0833333333333333},
  "openrouter/openai/gpt-6.1-sol": {"inPerM":2,"outPerM":10,"cacheReadPerM":0.1,"cacheWritePerM":2.5},
  "openrouter/z-ai/glm-5.3": {"inPerM":0.07,"outPerM":7,"cacheReadPerM":0.065},
  "openrouter/z-ai/glm-5.3-flash": {"inPerM":0.15,"outPerM":0.5,"cacheReadPerM":0.03},

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
  // Google's official introductory rate (ai.google.dev), verified live 2026-08-19.
  // Scheduled to increase to $1.50/$7.50 on 2027-01-01 — not modeled here yet.
  // Official Gemini API rate verified 2026-09-11; same introductory window as 3.7.
  'gemini-3.6-flash': withDerivedCache(0.75, 3.75),
  'gemini-3.7-flash': withDerivedCache(0.75, 3.75),
  'gemini-3.8-flash': GEMINI_3_8_FLASH_PRICE,
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
  // GPT-5.6 Series rate (azure.microsoft.com/pricing/details/cognitive-services/azure-openai).
  // (Cached/write rates already match our 10%/125% derived-cache convention exactly against
  // Azure's own published cache rates for all three.)
  //
  // 2026-09-05 (ENG-1781): Terra and Luna re-verified stale — Azure cut both on 2026-07-30
  // mirroring OpenAI's direct-API cut (Terra -20%, Luna -80%) and this table was never
  // updated, so BYOK Terra/Luna calls were over-metered against the customer's usage cap
  // (Luna ~5x, Terra ~1.25x). Re-verified against Azure's official published GlobalStandard
  // rate via azurespeed.com/AzureAiModelPricing (Models.dev Azure catalog snapshot, meter
  // effective date 2026-07-01) and independently corroborated by cloudzero.com's 2026 Azure
  // OpenAI pricing guide and a LiteLLM maintainer issue (BerriAI/litellm#36192) documenting
  // the identical Azure-meter-vs-cost-map drift on the same two models. Sol unchanged — Azure
  // did not cut it. OpenRouter's per-endpoint listing corroborates but is not the source.
  'openrouter/openai/gpt-5.6-sol': withDerivedCache(5.0, 30.0),
  'openrouter/openai/gpt-5.6-terra': withDerivedCache(2.0, 12.0),
  'openrouter/openai/gpt-5.6-luna': withDerivedCache(0.2, 1.2),
  // ENG-1769 (2026-09-05): GPT-6 Astra — BYOK-routed to the same Azure
  // resource as the GPT-5.6 trio (deployment `gpt-6-astra`, GlobalStandard),
  // so Azure's GlobalStandard list rate applies, not OpenRouter's marketplace
  // price (identical today, but that is a coincidence, not the reason).
  // Live-confirmed 2026-09-05 from the BYOK generation record: 13 prompt +
  // 5 completion tokens billed $0.00013 + $0.00025 upstream = exactly $10 /
  // $50 per 1M. Cache read $1.00 / write $12.50 per 1M match OpenRouter's
  // listed input_cache_read / input_cache_write for this model, i.e. the
  // standard 10% / 125% derivation — no override needed.
  // NOT modeled: Azure/OpenAI reprice the WHOLE request to $20/$75 once the
  // prompt exceeds 272k tokens (OpenRouter `pricing.overrides`). No row in
  // this table models long-context tiers, and the BYOK path bills from this
  // table, so a >272k-token Astra call under-bills ~2x — see ENG-1774.
  'openrouter/openai/gpt-6-astra': withDerivedCache(10.0, 50.0),
  // ENG-199/ENG-1685: Claude Fable 5.1 (Anthropic, released 2026-09-01),
  // routed through OpenRouter per the ENG-9/ENG-1414 gateway convention —
  // same as every other OpenRouter entry in this block, NOT the direct
  // Bedrock/Vertex path FABLE_5_1_PRICE's sibling FABLE_5_PRICE also serves
  // (see 'claude-fable-5' / 'anthropic.claude-fable-5' above; that pair
  // predates the OpenRouter migration and stays for the ids that still
  // resolve there). Live-verified against openrouter.ai/anthropic/claude-fable-5.1
  // 2026-09-01: $10/$50 base rate (unchanged from Fable 5), cache-read cut
  // 75% to $0.25/1M (Anthropic-served row — OpenRouter's Balanced routing
  // mode's default provider). FABLE_5_1_PRICE already encodes the override;
  // reused here (not re-derived) so the two ids can never drift on price.
  'openrouter/anthropic/claude-fable-5.1': FABLE_5_1_PRICE,
  // Claude Opus 5.5 (released 2026-09-22), OpenRouter-routed per ENG-9 —
  // same pattern as Fable 5.1 above. OpenRouter `usage.cost` remains the
  // per-call authority; this entry is the pre-call estimate + BYOK fallback.
  'openrouter/anthropic/claude-opus-5.5': OPUS_5_5_PRICE,
  // 2026-09-22 adds, live-verified against openrouter.ai model pricing.
  // Sol/Luna cache rates match the 10%/125% convention exactly. Grok 4.7's
  // cache read is 25% of input ($0.40), so it is overridden. None model the
  // >272k (OpenAI) / >200k (xAI) long-context 2x tier — same gap as ENG-1774.
  'openrouter/openai/gpt-6-sol': withDerivedCache(2.0, 10.0),
  'openrouter/openai/gpt-6-luna': withDerivedCache(0.1, 0.5),
  'openrouter/x-ai/grok-4.7': { ...withDerivedCache(1.6, 4.8), cacheReadPerM: 0.4 },
  'openrouter/x-ai/grok-4.6': withDerivedCache(2.0, 6.0), // was $3/$15 — stale, ~2x over live
  'openrouter/deepseek/deepseek-v4-pro': withDerivedCache(0.657, 1.315), // live "62% off" promo; lowest-confidence entry in this batch — the promo makes list price hard to reconstruct cleanly, re-verify if this model becomes cost-sensitive
  'openrouter/deepseek/deepseek-v4-flash': withDerivedCache(0.068, 0.168), // was ~2x over live
  'openrouter/qwen/qwen3.8-max-0902': withDerivedCache(2.0, 6.0),
  // DEPRECATED ALIAS, not a registry model: the pre-rename id (LEGACY_MODEL_ALIASES maps it to
  // -0902). Kept, same $2/$6, so late/in-flight/engine-posted usage rows still stamped with the
  // old id meter at the real rate instead of $0. Safe to drop once no usage rows carry it.
  'openrouter/qwen/qwen3.8-max': withDerivedCache(2.0, 6.0),
  // 2026-08-26: NOT the $0.35/$2.75 headline listing price — OpenRouter
  // aggregates 10 upstream providers for this model ($0.35-$0.48 in,
  // $2.55-$3.40 out; cheapest = Chutes, priciest = Io Net) and our
  // callLLM() request has no `provider.sort: 'price'`, so routing is
  // non-deterministic. Two live default-routed test calls both landed on
  // Io Net (the priciest provider) at $0.48/$3.40. Using the 10-provider
  // average ($0.43/$3.00) rather than the cheapest listing, to avoid
  // systematically undercharging — re-verify if this model becomes
  // cost-sensitive, same caveat as deepseek-v4-pro above.
  'openrouter/qwen/qwen3.8-27b': withDerivedCache(0.43, 3.0),
  'openrouter/mistralai/mistral-small-2603': withDerivedCache(0.15, 0.6),
  'openrouter/moonshotai/kimi-k3': withDerivedCache(2.6, 13.0), // was $0.60/$2.50 — 4.8x under live; this is a frontier-tier model, not budget
  'openrouter/moonshotai/kimi-k2.7-code': withDerivedCache(0.67, 3.4),
  'openrouter/z-ai/glm-5.2': withDerivedCache(0.42, 1.32), // live "70% off" promo vs list
  'openrouter/z-ai/glm-4.7-flash': withDerivedCache(0.06, 0.4),
  // Perplexity search fees/reasoning charges are additional provider-native
  // dimensions. OpenRouter's reported `usage.cost` remains authoritative; these
  // token rates are only the pre-call/local fallback required by this registry.
  'openrouter/perplexity/sonar-deep-research': withDerivedCache(2, 8),
  'openrouter/perplexity/sonar-pro-search': withDerivedCache(3, 15),

  // ── Embeddings (output side is always 0 — embeddings have no completion) ────
  'openai/text-embedding-3-large': { inPerM: 0.13, outPerM: 0 },
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
 * Video generation models — USD per clip (longer videos bill as multiple clips; clip
 * length per model is VIDEO_CLIP_MAX_SECONDS, default 8s).
 * Ported from agentModeService.estimateVideoGenerationCost().
 */
export const VIDEO_GENERATION_PRICING_USD_PER_CLIP: Record<string, number> = {
  // gemini-omni-1.1-flash: a full 10s clip at GEMINI_OMNI_VIDEO_ESTIMATE_USD_PER_SECOND.
  // videoGenerationCostUsd prices Omni per actual second; this entry marks it as
  // per-generation priced. Real cost comes from usage — see omniVideoUsageCostUsd.
  'gemini-omni-1.1-flash': 1.014,
  // Retired Veo ids (shut down 2026-10-22) — kept so historical records still price.
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
/**
 * True when `model` is priced PER GENERATION (an image, or a video clip) rather
 * than per token.
 *
 * ENG-1691: these models are billed by the artefact, so token counts describe
 * nothing chargeable about the call. Metering one through the token path writes
 * a $0 row alongside the real per-generation row — two ledger entries for one
 * API call, on a model that generates no text. `llmClients.ts` already states
 * the rule ("NOT for image/video, which are per-generation priced"); this makes
 * it checkable instead of a comment a caller has to have read.
 */
export function isPerGenerationPriced(model: string | undefined | null): boolean {
  if (!model) return false;
  return (
    Object.prototype.hasOwnProperty.call(IMAGE_GENERATION_PRICING_USD, model) ||
    Object.prototype.hasOwnProperty.call(VIDEO_GENERATION_PRICING_USD_PER_CLIP, model)
  );
}

export function imageGenerationCostUsd(model: string, resolution?: '1K'): number {
  // Explicit 1K output: 1,120 image tokens × $60/M (ai.google.dev/gemini-api/docs/pricing, 2026-09-11).
  if (model === 'gemini-3.1-flash-image' && resolution === '1K') return 0.0672;
  return IMAGE_GENERATION_PRICING_USD[model] ?? 0.04;
}

/** Gemini 3.1 Flash Image at explicit 1K: official standard rates, verified 2026-09-11. */
export function geminiFlashImageUsage(usage: unknown, hasImage: boolean) {
  const data = usage && typeof usage === 'object' ? usage as Record<string, unknown> : {};
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const inputTokens = count(data.promptTokenCount);
  const candidates = count(data.candidatesTokenCount);
  const thinking = count(data.thoughtsTokenCount);
  const imageTokens = hasImage ? 1120 : 0;
  return {
    inputTokens, outputTokens: candidates + thinking,
    costUsdOverride: (hasImage ? imageGenerationCostUsd('gemini-3.1-flash-image', '1K') : 0) +
      (inputTokens * 0.5 + (Math.max(0, candidates - imageTokens) + thinking) * 3) / 1e6,
  };
}

/**
 * gemini-omni-1.1-flash estimate when the API reports no usage: $17.50/M video
 * output tokens x 5,792 tokens/s at 720p. Billed on the actual requested seconds.
 */
export const GEMINI_OMNI_VIDEO_ESTIMATE_USD_PER_SECOND = 0.1014;

/** Max seconds a single generated clip covers, per model (default 8s). */
export const VIDEO_CLIP_MAX_SECONDS: Record<string, number> = {
  'gemini-omni-1.1-flash': 10,
};

/**
 * Per-generation USD cost for a video model. Video is billed per clip; a longer
 * requested duration bills as ceil(seconds / clipSeconds) clips.
 */
export function videoGenerationCostUsd(model: string, durationSeconds?: number): number {
  if (model === GEMINI_OMNI_VIDEO_MODEL) {
    // Omni is asked for each clip's exact length, so the estimate is per actual second.
    const seconds = omniClipDurations(durationSeconds).reduce((a, b) => a + b, 0);
    return seconds * GEMINI_OMNI_VIDEO_ESTIMATE_USD_PER_SECOND;
  }
  const clipPrice = VIDEO_GENERATION_PRICING_USD_PER_CLIP[model] ?? 3.2;
  return clipPrice * videoClipCount(durationSeconds, model);
}

/**
 * How many billed clips a requested duration is. Shared with the spend ledger
 * (ENG-1934), so an event's generation quantity is the same number the cost
 * was multiplied by.
 */
export function videoClipCount(durationSeconds?: number, model?: string): number {
  if (model === GEMINI_OMNI_VIDEO_MODEL) return omniClipDurations(durationSeconds).length;
  const clipSeconds = (model && VIDEO_CLIP_MAX_SECONDS[model]) || 8;
  return durationSeconds && durationSeconds > clipSeconds
    ? Math.ceil(durationSeconds / clipSeconds)
    : 1;
}

/** gemini-omni-1.1-flash token rates (USD per 1M tokens), ai.google.dev, 2026-10-08. */
export const GEMINI_OMNI_VIDEO_TOKEN_PRICING = {
  inputPerM: 1.5,
  textOutputPerM: 9,
  videoOutputPerM: 17.5,
} as const;

/**
 * Actual USD cost of one gemini-omni-1.1-flash interaction from its `usage` block.
 * Video output tokens bill at the video rate, other output tokens at the text rate,
 * input at the input rate. When there is no per-modality breakdown, every output
 * token is billed at the (higher) video rate. Returns undefined when the response
 * carries no usable usage — the caller then falls back to the per-clip estimate.
 */
export function omniVideoUsageCostUsd(usage: unknown): number | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  const totalOut = n(u.total_output_tokens);
  if (totalOut === undefined) return undefined;
  const input = n(u.total_input_tokens) ?? 0;
  const byModality = Array.isArray(u.output_tokens_by_modality) ? u.output_tokens_by_modality : undefined;
  let videoOut = totalOut;
  if (byModality) {
    videoOut = byModality
      .filter((m: any) => m?.modality === 'video')
      .reduce((sum: number, m: any) => sum + (n(m?.tokens) ?? 0), 0);
  }
  const otherOut = Math.max(0, totalOut - videoOut);
  const p = GEMINI_OMNI_VIDEO_TOKEN_PRICING;
  return (input * p.inputPerM + otherOut * p.textOutputPerM + videoOut * p.videoOutputPerM) / 1e6;
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


/**
 * ENG-2957: Gemini Live bills each modality at its own rate, and a voice call is mostly AUDIO tokens, which the text
 * entry above (the approximation used before) under-prices about 4x on input and 2.7x on output. USD per 1M tokens,
 * paid tier, from Google's pricing page (aistudio.google.com/docs/pricing, read 2026-11-12): input text 0.75, audio 3.00,
 * image/video 1.00; output (thinking included) text 4.50, audio 12.00. Keyed by the bare model id.
 */
export const LIVE_MODALITY_PRICES: Readonly<Record<string, { input: Readonly<Record<string, number>>; output: Readonly<Record<string, number>> }>> = {
  'gemini-3.1-flash-live-preview': {
    input: { TEXT: 0.75, AUDIO: 3.0, IMAGE: 1.0, VIDEO: 1.0 },
    output: { TEXT: 4.5, AUDIO: 12.0 },
  },
};

interface LiveModalityTokens { modality?: unknown; tokenCount?: unknown }
/** The parts of a Gemini Live `usageMetadata` that carry billable tokens. */
export interface LiveUsageMetadata {
  promptTokenCount?: number;
  responseTokenCount?: number;
  candidatesTokenCount?: number;
  toolUsePromptTokenCount?: number;
  thoughtsTokenCount?: number;
  promptTokensDetails?: LiveModalityTokens[];
  responseTokensDetails?: LiveModalityTokens[];
  candidatesTokensDetails?: LiveModalityTokens[];
  toolUsePromptTokensDetails?: LiveModalityTokens[];
}

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** Tokens per modality from a details list, plus the remainder of `total` the details do not cover. */
function splitByModality(total: number, details: LiveModalityTokens[] | undefined): { byModality: Record<string, number>; uncovered: number } {
  const byModality: Record<string, number> = {};
  let covered = 0;
  for (const d of Array.isArray(details) ? details : []) {
    const n = count(d?.tokenCount);
    if (!n) continue;
    const m = typeof d?.modality === 'string' ? d.modality.toUpperCase() : 'UNKNOWN';
    byModality[m] = (byModality[m] ?? 0) + n;
    covered += n;
  }
  return { byModality, uncovered: Math.max(0, total - covered) };
}

/**
 * USD cost of one Gemini Live usage report, priced per modality. Null when the model has no per-modality rates (the
 * caller then falls back to token pricing). A modality without a listed rate is billed at the highest rate of its
 * direction, so an unknown kind of token is never under-charged; tokens a report does not break down are billed as
 * text; thinking tokens are output text. No cache discount is applied (Google does not list one for Live).
 */
export function computeLiveModalityCostUsd(model: string, usage: LiveUsageMetadata | null | undefined): number | null {
  const rates = LIVE_MODALITY_PRICES[String(model || '').replace(/^models\//, '')];
  if (!rates || !usage) return null;
  const maxIn = Math.max(...Object.values(rates.input));
  const maxOut = Math.max(...Object.values(rates.output));
  const price = (tokens: Record<string, number>, table: Record<string, number>, max: number) =>
    Object.entries(tokens).reduce((sum, [m, n]) => sum + n * (table[m] ?? max), 0);

  const prompt = splitByModality(count(usage.promptTokenCount), usage.promptTokensDetails);
  const toolUse = splitByModality(count(usage.toolUsePromptTokenCount), usage.toolUsePromptTokensDetails);
  const outputTotal = count(usage.responseTokenCount) || count(usage.candidatesTokenCount);
  const output = splitByModality(outputTotal, usage.responseTokensDetails ?? usage.candidatesTokensDetails);

  const inputUsd = price(prompt.byModality, rates.input, maxIn) + prompt.uncovered * rates.input.TEXT
    + price(toolUse.byModality, rates.input, maxIn) + toolUse.uncovered * rates.input.TEXT;
  const outputUsd = price(output.byModality, rates.output, maxOut) + output.uncovered * rates.output.TEXT
    + count(usage.thoughtsTokenCount) * rates.output.TEXT;
  return (inputUsd + outputUsd) / 1_000_000;
}
