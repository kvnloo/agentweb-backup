/**
 * Tests for the shadow-metering price book.
 *
 * The "registry coverage" suite is the CI guard: every model id in
 * the LLM model registry MUST have a price entry. It imports the registry from
 * agentMode/llmModelRegistry.ts (ENG-1831), which has no runtime dependencies,
 * so the guard stays cheap and side-effect free.
 */

import { LLM_MODEL_REGISTRY } from '../services/agentMode/llmModelRegistry';
import {
  MODEL_PRICING,
  LLM_PRICE_BOOK_VERSION,
  LIVE_MODALITY_PRICES,
  LLM_PRICE_BOOK_PROVENANCE,
  IMAGE_GENERATION_PRICING_USD,
  VIDEO_GENERATION_PRICING_USD_PER_CLIP,
  getModelPrice,
  imageGenerationCostUsd,
  videoGenerationCostUsd,
  videoClipCount,
  omniVideoUsageCostUsd,
  isPerGenerationPriced,
  costScoreFromPrice,
  __resetUnknownModelWarnsForTests,
} from '../utils/llmPricing';
import { BEDROCK_EXTENDED_CACHE_TTL_MODELS } from '../utils/bedrockInferenceProfiles';

function parseLlmModelsRegistryKeys(): string[] {
  return Object.keys(LLM_MODEL_REGISTRY);
}

/**
 * ENG-1934: every LLM spend event carries LLM_PRICE_BOOK_VERSION, so a price
 * edit that forgets to bump it would leave two different prices under one
 * version and make historical events impossible to re-derive. A fingerprint of
 * the tables is pinned to the version; changing a price fails this test until
 * BOTH are updated in the same commit.
 */
describe('price book version (ENG-1250 §5, ENG-1934)', () => {
  const canonical = (value: unknown): string =>
    value && typeof value === 'object'
      ? `{${Object.keys(value as object)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
          .join(',')}}`
      : JSON.stringify(value);

  const fingerprint = () =>
    require('crypto')
      .createHash('sha256')
      .update(canonical({ MODEL_PRICING, IMAGE_GENERATION_PRICING_USD, VIDEO_GENERATION_PRICING_USD_PER_CLIP, LIVE_MODALITY_PRICES }))
      .digest('hex')
      .slice(0, 16);

  it('is a dated version string', () => {
    expect(LLM_PRICE_BOOK_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(LLM_PRICE_BOOK_PROVENANCE).toBe(`llm-price-book:${LLM_PRICE_BOOK_VERSION}`);
  });

  it('matches the prices it versions — bump LLM_PRICE_BOOK_VERSION and this pin together', () => {
    expect({ version: LLM_PRICE_BOOK_VERSION, fingerprint: fingerprint() }).toEqual({
      version: '2026-11-15',
      // Sonnet 5.5 cache reads corrected from $0.20/M to the provider's $0.10/M.
      fingerprint: '669a45de042e3931',
    });
  });
});

// Model-upgrade audit 2026-11-15: OpenRouter's anthropic/claude-sonnet-5.5 record lists
// input_cache_read 0.0000001/token = $0.10/1M (5% of input, the same generation cut as
// Opus 5.5's $0.20 on a $4 input). The book had $0.20 — 2x the provider rate.
describe('Claude Sonnet 5.5 price (model-upgrade audit 2026-11-15)', () => {
  it('matches the provider-published rates, including the 5%-of-input cache read', () => {
    expect(MODEL_PRICING['openrouter/anthropic/claude-sonnet-5.5']).toEqual({
      inPerM: 2,
      outPerM: 10,
      cacheReadPerM: 0.1,
      cacheWritePerM: 2.5,
    });
  });
});

describe('llmPricing', () => {
  beforeEach(() => {
    __resetUnknownModelWarnsForTests();
    jest.restoreAllMocks();
  });

  describe('registry coverage (CI guard)', () => {
    it('has a price entry for EVERY model in the agentModeService llmModels registry', () => {
      const registryKeys = parseLlmModelsRegistryKeys();
      // Sanity: the registry currently has 15 models; if parsing breaks, fail loudly.
      expect(registryKeys.length).toBeGreaterThanOrEqual(15);

      const missing = registryKeys.filter((model) => !MODEL_PRICING[model]);
      expect(missing).toEqual([]);
    });

    it('tolerates documented deprecated alias price keys that are not registry models', () => {
      // Pre-rename ids kept priced so late usage rows still meter (see LEGACY_MODEL_ALIASES).
      const DEPRECATED_ALIAS_PRICE_KEYS = ['openrouter/qwen/qwen3.8-max'];
      for (const key of DEPRECATED_ALIAS_PRICE_KEYS) {
        expect(parseLlmModelsRegistryKeys()).not.toContain(key);
        expect(MODEL_PRICING[key]).toEqual(MODEL_PRICING['openrouter/qwen/qwen3.8-max-0902']);
      }
    });

    it('covers the chatbot + embedding models from the provider report', () => {
      for (const model of [
        'gpt-4o',
        'gpt-4.1',
        'text-embedding-3-large',
        'text-embedding-3-small',
        'text-embedding-ada-002',
      ]) {
        expect(MODEL_PRICING[model]).toBeDefined();
      }
    });

    it('covers image and video generation models from the provider report', () => {
      for (const model of [
        'gpt-image-1',
        'gpt-image-2',
        'gemini-2.5-flash-image',
        'gemini-3-pro-image-preview',
        'gemini-3.1-flash-image',
        'gemini-3.1-flash-image-preview',
        'gen4_image',
      ]) {
        expect(IMAGE_GENERATION_PRICING_USD[model]).toBeGreaterThan(0);
      }
      expect(VIDEO_GENERATION_PRICING_USD_PER_CLIP['veo-3.1-generate-preview']).toBe(3.2);
      expect(VIDEO_GENERATION_PRICING_USD_PER_CLIP['veo-3.1-fast-generate-preview']).toBe(1.4);
      expect(VIDEO_GENERATION_PRICING_USD_PER_CLIP['veo-3-generate-preview']).toBe(3.2);
      expect(VIDEO_GENERATION_PRICING_USD_PER_CLIP['seedance-2.0']).toBe(1.55);
    });
  });

  // ENG-200 pricing accuracy pass: lock the corrected/added list prices so a stale
  // value can never silently come back. Rates verified against the official
  // Anthropic / OpenAI / Google pricing pages (Jul 2026). in/out = USD per 1M tokens.
  describe('ENG-200 accurate list prices', () => {
    const expectRate = (model: string, inPerM: number, outPerM: number) => {
      const price = MODEL_PRICING[model];
      expect(price).toBeDefined();
      expect(price.inPerM).toBe(inPerM);
      expect(price.outPerM).toBe(outPerM);
    };

    it('prices Opus at the current $5/$25 tier, not the legacy $15/$75', () => {
      expectRate('anthropic.claude-opus-4-8', 5, 25);
      expectRate('anthropic.claude-opus-4-6-v1', 5, 25);
    });

    it('has corrected GPT rates', () => {
      expectRate('gpt-5.4', 2.5, 15);
    });

    it('has corrected Gemini rates', () => {
      expectRate('gemini-3-flash-preview', 0.5, 3);
      expectRate('gemini-3.1-pro-preview', 2, 12);
      expectRate('gemini-3.1-flash-lite', 0.25, 1.5);
      expectRate('gemini-3.5-flash', 1.5, 9);
    });

    it('prices gemini-2.5-flash (previously missing -> recorded $0)', () => {
      expectRate('gemini-2.5-flash', 0.3, 2.5);
    });

    it('stages Fable 5 and Haiku 4.5 so higher-cost models are metered when enabled', () => {
      expectRate('claude-fable-5', 10, 50);
      expectRate('claude-haiku-4-5', 1, 5);
    });

    /*
     * ENG-744 — the Claude 5 generation must be priced under the EXACT registry
     * id it is invoked as, or getModelPrice() returns null and the usage ledger
     * silently books $0 (the ENG-693 vendor-dimension blind spot).
     *
     * Haiku 4.5 is the trap: the pre-existing 'anthropic.claude-haiku-4-5' key
     * does NOT cover the registry id 'anthropic.claude-haiku-4-5-20251001-v1:0'
     * — canonicalModelId only strips a trailing bare -YYYY-MM-DD, and this id
     * ends in '-20251001-v1:0'. It needs its own key.
     */
    it('prices the Claude 5 generation under its exact registry id', () => {
      expectRate('anthropic.claude-opus-5', 5, 25);
      expectRate('anthropic.claude-sonnet-5', 3, 15);
      expectRate('anthropic.claude-haiku-4-5-20251001-v1:0', 1, 5);
    });

    it('resolves a price for every Claude 5 registry id (no silent $0 in the ledger)', () => {
      for (const id of [
        'anthropic.claude-opus-5',
        'anthropic.claude-sonnet-5',
        'anthropic.claude-haiku-4-5-20251001-v1:0',
      ]) {
        expect(getModelPrice(id)).not.toBeNull();
      }
    });

    it('prices the Pro image model above the flash tier', () => {
      expect(IMAGE_GENERATION_PRICING_USD['gemini-3-pro-image-preview']).toBe(0.134);
    });

    // ENG-207: previously UNVERIFIED rows, now confirmed against published rates.
    it('prices gpt-5.5 at the confirmed $5/$30 with a real $0.50/1M cache-read', () => {
      expectRate('gpt-5.5', 5, 30);
      // withDerivedCache leaves cacheRead to the inPerM*0.1 convention, which
      // equals the published $0.50/1M cached rate — so no override is needed.
      expect(MODEL_PRICING['gpt-5.5'].cacheReadPerM ?? MODEL_PRICING['gpt-5.5'].inPerM * 0.1).toBeCloseTo(0.5, 6);
    });

    it('prices GPT-6 Astra at the Azure GlobalStandard $10/$50 BYOK rate, not a marketplace promo (ENG-1769)', () => {
      // BYOK traffic bills at Azure's list rate; the backend only takes
      // OpenRouter's usage.cost override when is_byok !== true, so this row
      // is what customers are actually charged. Live-confirmed 2026-09-05:
      // 13 prompt + 5 completion tokens -> $0.00013 + $0.00025 upstream.
      const price = getModelPrice('openrouter/openai/gpt-6-astra');
      expect(price).not.toBeNull();
      expect(price!.inPerM).toBe(10);
      expect(price!.outPerM).toBe(50);
      expect(price!.cacheReadPerM).toBeCloseTo(1.0, 10);
      expect(price!.cacheWritePerM).toBeCloseTo(12.5, 10);
    });

    it('prices gemini-3.1-flash-live-preview at the confirmed $0.75/$4.50 text rate', () => {
      expectRate('gemini-3.1-flash-live-preview', 0.75, 4.5);
    });

    it('prices the Deep Research agents at Gemini 3.1 Pro rates ($2/$12), not the old estimate', () => {
      expectRate('deep-research-preview-04-2026', 2, 12);
      expectRate('deep-research-max-preview-04-2026', 2, 12);
    });
  });

  describe('getModelPrice', () => {
    it('returns null for gemini-3-pro-preview — retired 2026-03-09, removed from the registry by ENG-744 (ENG-750)', () => {
      expect(getModelPrice('gemini-3-pro-preview')).toBeNull();
    });

    it('does not resolve the retired id through alias canonicalization or a dated-suffix variant (ENG-750)', () => {
      // Boundary: a dated snapshot of the retired model must not normalize onto
      // some other model's live price entry.
      expect(getModelPrice('gemini-3-pro-preview-2026-03-09')).toBeNull();
    });

    it('returns null for unknown and empty model ids instead of throwing (ENG-750)', () => {
      expect(getModelPrice('totally-unknown-model')).toBeNull();
      expect(getModelPrice('')).toBeNull();
    });

    it('still prices the neighboring live Gemini entries after the removal (ENG-750)', () => {
      // Success path: the deletion must not clip adjacent registry rows.
      expect(getModelPrice('gemini-3.1-flash-live-preview')).not.toBeNull();
      expect(getModelPrice('deep-research-preview-04-2026')).not.toBeNull();
    });

    it('returns the price entry for a known model', () => {
      const price = getModelPrice('anthropic.claude-sonnet-4-6');
      expect(price).not.toBeNull();
      expect(price!.inPerM).toBe(3);
      expect(price!.outPerM).toBe(15);
      expect(price!.cacheReadPerM).toBeCloseTo(0.3, 10);
      expect(price!.cacheWritePerM).toBeCloseTo(3.75, 10);
    });

    it('derives cache prices as 10% / 125% of input price for token models', () => {
      // Models whose provider publishes an explicit cache rate that differs from the
      // 10%/125% convention (see the ModelPrice cache-price docs). gpt-4o's real
      // cached-input rate is $1.25 (50% of input), not the derived 10%.
      // refreshModelCatalog.ts's writer registers every auto-added model here directly
      // at add time (ENG-2293) — not inferred from the registry's human-editable
      // `description` field, which the draft-PR review step explicitly tells
      // reviewers to rewrite before marking a model ready.
      const explicitCacheOverrides = new Set(['gpt-4o', 'openrouter/anthropic/claude-fable-5.1', 'gemini-3.8-flash', 'openrouter/anthropic/claude-opus-5.5', 'openrouter/x-ai/grok-4.7', 'openrouter/anthropic/claude-sonnet-5.5', 'openrouter/deepseek/deepseek-v4-pro-0813', 'openrouter/deepseek/deepseek-v4.1-flash', 'openrouter/google/gemini-3.5-flash-lite', 'openrouter/openai/gpt-6.1-sol', 'openrouter/z-ai/glm-5.3', 'openrouter/z-ai/glm-5.3-flash', 'openrouter/anthropic/claude-haiku-5.5']);
      for (const [model, price] of Object.entries(MODEL_PRICING)) {
        if (price.outPerM === 0) continue; // embeddings have no cache convention
        if (explicitCacheOverrides.has(model)) continue;
        expect(price.cacheReadPerM).toBeCloseTo(price.inPerM * 0.1, 10);
        expect(price.cacheWritePerM).toBeCloseTo(price.inPerM * 1.25, 10);
        expect(model).toBeTruthy();
      }
    });

    it('keeps extended-TTL models on the declared 1.25x rate (ENG-893)', () => {
      // The 1-hour (2x) rate is applied from the response's TTL breakdown, not
      // from the price book — see cacheWriteCost. Declaring 2x here would
      // over-bill every non-agent-mode caller of the same model id.
      expect(BEDROCK_EXTENDED_CACHE_TTL_MODELS.size).toBeGreaterThan(0);
      for (const model of BEDROCK_EXTENDED_CACHE_TTL_MODELS) {
        const price = getModelPrice(model);
        expect(price).not.toBeNull();
        expect(price!.cacheWritePerM).toBeCloseTo(price!.inPerM * 1.25, 10);
      }
    });

    it('uses the real published cache-read rate for gpt-4o ($1.25, not the 10% default)', () => {
      const price = getModelPrice('gpt-4o');
      expect(price).not.toBeNull();
      expect(price!.cacheReadPerM).toBe(1.25);
    });

    it('resolves Fable/Haiku under the Bedrock anthropic.-prefixed id, not just the bare Vertex id', () => {
      // ENG-199 may wire Fable via Bedrock (anthropic.claude-fable-5) rather than
      // Vertex (bare) — both ids must price identically or a rollout records $0.
      for (const id of ['claude-fable-5', 'anthropic.claude-fable-5']) {
        const price = getModelPrice(id);
        expect(price).not.toBeNull();
        expect(price!.inPerM).toBe(10);
        expect(price!.outPerM).toBe(50);
      }
      for (const id of ['claude-haiku-4-5', 'anthropic.claude-haiku-4-5']) {
        const price = getModelPrice(id);
        expect(price).not.toBeNull();
        expect(price!.inPerM).toBe(1);
        expect(price!.outPerM).toBe(5);
      }
    });

    // ENG-207: Azure/OpenAI return a dated snapshot or rolling-alias `response.model`
    // (e.g. "gpt-4.1-2025-04-14", "gpt-chat-latest") even when we call a deployment
    // named for the canonical model. Without normalization these meter at $0 — the
    // exact blind spot ENG-200 exists to close.
    it('normalizes a dated snapshot suffix to the canonical model price', () => {
      const base = getModelPrice('gpt-4.1');
      const dated = getModelPrice('gpt-4.1-2025-04-14');
      expect(base).not.toBeNull();
      expect(dated).not.toBeNull();
      expect(dated!.inPerM).toBe(base!.inPerM);
      expect(dated!.outPerM).toBe(base!.outPerM);
    });

    // The gpt-chat-latest rolling alias (for the since-removed gpt-5-chat-2
    // deployment) was removed 2026-08-19 along with that deployment — MODEL_ID_ALIASES
    // is empty for now; this asserts it stays a well-behaved miss, not a crash.
    it('an unmapped rolling-alias-shaped id falls through to unknown-model handling, not a crash', () => {
      expect(() => getModelPrice('gpt-chat-latest')).not.toThrow();
    });

    it('handles a missing/empty model id without throwing (recordUsage passes undefined)', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      expect(getModelPrice(undefined as any)).toBeNull();
      expect(getModelPrice('' as any)).toBeNull();
      warnSpy.mockRestore();
    });

    it('still returns null for an unknown model with a date suffix (no false match)', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      expect(getModelPrice('totally-made-up-model-2025-04-14')).toBeNull();
      warnSpy.mockRestore();
    });

    it('returns null for an unknown model — NEVER another model price', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      expect(getModelPrice('totally-made-up-model')).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('warns only once per model per process (deduped)', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      getModelPrice('unknown-model-a');
      getModelPrice('unknown-model-a');
      getModelPrice('unknown-model-a');
      expect(warnSpy).toHaveBeenCalledTimes(1);

      getModelPrice('unknown-model-b');
      expect(warnSpy).toHaveBeenCalledTimes(2);
    });

    it('returns null WITHOUT warning for image/video models (priced per-image/clip elsewhere)', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      // GA image model + back-compat preview alias + a video model
      expect(getModelPrice('gemini-3.1-flash-image')).toBeNull();
      expect(getModelPrice('gemini-3.1-flash-image-preview')).toBeNull();
      expect(getModelPrice('gpt-image-1')).toBeNull();
      expect(getModelPrice('veo-3.1-generate-preview')).toBeNull();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('embedding models price output at 0', () => {
      const price = getModelPrice('text-embedding-3-large');
      expect(price).not.toBeNull();
      expect(price!.inPerM).toBe(0.13);
      expect(price!.outPerM).toBe(0);
    });
  });

  describe('imageGenerationCostUsd', () => {
    it('returns the per-image price for known models', () => {
      expect(imageGenerationCostUsd('gemini-3-pro-image-preview')).toBe(0.134);
      expect(imageGenerationCostUsd('gpt-image-1')).toBe(0.04);
      expect(imageGenerationCostUsd('gen4_image')).toBe(0.05);
    });

    it('falls back to $0.04 for an unknown image model', () => {
      expect(imageGenerationCostUsd('mystery-image-model')).toBe(0.04);
    });
  });

  describe('videoGenerationCostUsd', () => {
    it('prices a single clip (<=8s) at the per-clip rate', () => {
      expect(videoGenerationCostUsd('veo-3.1-generate-preview', 8)).toBe(3.2);
      expect(videoGenerationCostUsd('seedance-2.0', 5)).toBe(1.55);
      expect(videoGenerationCostUsd('veo-3.1-generate-preview')).toBe(3.2); // undefined → 1 clip
    });

    it('bills longer durations as ceil(seconds / 8) clips', () => {
      expect(videoGenerationCostUsd('veo-3.1-generate-preview', 16)).toBe(6.4); // 2 clips
      expect(videoGenerationCostUsd('veo-3.1-generate-preview', 24)).toBeCloseTo(9.6, 5); // 3 clips
      expect(videoGenerationCostUsd('veo-3.1-fast-generate-preview', 16)).toBeCloseTo(2.8, 5); // 2 × 1.40
    });

    it('falls back to $3.20/clip for an unknown video model', () => {
      expect(videoGenerationCostUsd('mystery-video-model', 8)).toBe(3.2);
    });

    it('estimates gemini-omni-1.1-flash at $0.1014 per actual requested second', () => {
      expect(VIDEO_GENERATION_PRICING_USD_PER_CLIP['gemini-omni-1.1-flash']).toBeCloseTo(10 * 0.1014, 10);
      expect(videoGenerationCostUsd('gemini-omni-1.1-flash', 5)).toBeCloseTo(5 * 0.1014, 10);
      expect(videoGenerationCostUsd('gemini-omni-1.1-flash', 8)).toBeCloseTo(8 * 0.1014, 10);
      expect(videoGenerationCostUsd('gemini-omni-1.1-flash', 10)).toBeCloseTo(10 * 0.1014, 10);
      expect(videoGenerationCostUsd('gemini-omni-1.1-flash', 24)).toBeCloseTo(24 * 0.1014, 10);
      // Default 8s; rounded; floored at Omni's 3s minimum.
      expect(videoGenerationCostUsd('gemini-omni-1.1-flash')).toBeCloseTo(8 * 0.1014, 10);
      expect(videoGenerationCostUsd('gemini-omni-1.1-flash', 6.6)).toBeCloseTo(7 * 0.1014, 10);
      expect(videoGenerationCostUsd('gemini-omni-1.1-flash', 1)).toBeCloseTo(3 * 0.1014, 10);
      expect(isPerGenerationPriced('gemini-omni-1.1-flash')).toBe(true);
      expect(getModelPrice('gemini-omni-1.1-flash')).toBeNull();
    });

    it('counts Omni clips per 10s while other models keep the 8s clip', () => {
      expect(videoClipCount(16, 'gemini-omni-1.1-flash')).toBe(2);
      expect(videoClipCount(10, 'gemini-omni-1.1-flash')).toBe(1);
      expect(videoClipCount(16, 'seedance-2.0')).toBe(2);
      expect(videoClipCount(9)).toBe(2);
    });
  });

  describe('omniVideoUsageCostUsd (bill gemini-omni-1.1-flash on actual usage)', () => {
    it('bills video output at $17.50/M, other output at $9/M and input at $1.50/M', () => {
      const cost = omniVideoUsageCostUsd({
        total_input_tokens: 2_000,
        total_output_tokens: 58_920,
        output_tokens_by_modality: [{ modality: 'video', tokens: 57_920 }, { modality: 'text', tokens: 1_000 }],
      });
      expect(cost).toBeCloseTo((2_000 * 1.5 + 1_000 * 9 + 57_920 * 17.5) / 1e6, 12);
    });

    it('bills every output token at the video rate when there is no modality breakdown', () => {
      expect(omniVideoUsageCostUsd({ total_output_tokens: 1_000_000 })).toBeCloseTo(17.5, 10);
    });

    it('an 8s 720p clip (5,792 tokens/s) costs ~$0.81', () => {
      expect(omniVideoUsageCostUsd({ total_output_tokens: 8 * 5_792 })).toBeCloseTo(0.81, 2);
    });

    it('returns undefined when usage is missing or unusable (caller estimates instead)', () => {
      expect(omniVideoUsageCostUsd(undefined)).toBeUndefined();
      expect(omniVideoUsageCostUsd({})).toBeUndefined();
      expect(omniVideoUsageCostUsd({ total_output_tokens: -5 })).toBeUndefined();
      expect(omniVideoUsageCostUsd('nope')).toBeUndefined();
    });
  });

  // 2026-08-19: the picker's cost meter used to store costScore as a separate
  // hand-typed number per model. 11 of 29 had already drifted from what this
  // exact formula produces against real MODEL_PRICING by the time that was
  // caught. costScoreFromPrice replaces the hand-typed number so the two can
  // never disagree again — these tests pin the formula itself.
  describe('costScoreFromPrice', () => {
    it('computes the 75/25 blended-rate log score for a known real price', () => {
      // Claude Opus 5: $5/$25 -> blended $10.00/1M
      expect(costScoreFromPrice({ inPerM: 5, outPerM: 25 })).toBe(70);
      // GPT-4o Mini (OpenRouter): $0.15/$0.6 -> blended $0.2625/1M
      expect(costScoreFromPrice({ inPerM: 0.15, outPerM: 0.6 })).toBe(22);
    });

    it('clamps to 0 for a blended rate at or below the $0.05/1M floor', () => {
      expect(costScoreFromPrice({ inPerM: 0.01, outPerM: 0.01 })).toBe(0);
      expect(costScoreFromPrice({ inPerM: 0, outPerM: 0 })).toBe(0);
    });

    it('clamps to 100 for a blended rate at or above the $100/1M ceiling', () => {
      expect(costScoreFromPrice({ inPerM: 100, outPerM: 100 })).toBe(100);
      expect(costScoreFromPrice({ inPerM: 500, outPerM: 500 })).toBe(100);
    });

    it('always returns an integer 0-100', () => {
      for (const price of Object.values(MODEL_PRICING)) {
        const score = costScoreFromPrice(price);
        expect(Number.isInteger(score)).toBe(true);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(100);
      }
    });
  });
});
