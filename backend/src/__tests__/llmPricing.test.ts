/**
 * Tests for the shadow-metering price book.
 *
 * The "registry coverage" suite is the CI guard: every model id in
 * agentModeService's llmModels registry MUST have a price entry. It parses the
 * registry out of the source file (rather than importing the 470KB module with
 * its construction side effects) so the guard stays cheap and side-effect free.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  MODEL_PRICING,
  IMAGE_GENERATION_PRICING_USD,
  VIDEO_GENERATION_PRICING_USD_PER_CLIP,
  getModelPrice,
  __resetUnknownModelWarnsForTests,
} from '../utils/llmPricing';

function parseLlmModelsRegistryKeys(): string[] {
  const srcPath = path.join(__dirname, '..', 'services', 'agentModeService.ts');
  const src = fs.readFileSync(srcPath, 'utf8');
  const blockMatch = src.match(
    /private llmModels: Record<string, LLMModelConfig> = \{([\s\S]*?)\n {2}\};/
  );
  if (!blockMatch) {
    throw new Error('Could not locate the llmModels registry in agentModeService.ts');
  }
  const keys = [...blockMatch[1].matchAll(/^\s*'([^']+)':\s*\{/gm)].map((m) => m[1]);
  if (keys.length === 0) {
    throw new Error('Parsed zero model ids from the llmModels registry');
  }
  return keys;
}

function parseEstimateCostPricing(): Record<string, [number, number]> {
  const srcPath = path.join(__dirname, '..', 'services', 'agentModeService.ts');
  const src = fs.readFileSync(srcPath, 'utf8');
  const blockMatch = src.match(
    /const pricing: Record<string, \[number, number\]> = \{([\s\S]*?)\n {4}\};/
  );
  if (!blockMatch) {
    throw new Error('Could not locate the estimateCost pricing map in agentModeService.ts');
  }
  const entries: Record<string, [number, number]> = {};
  for (const m of blockMatch[1].matchAll(
    /'([^']+)':\s*\[([\d.]+),\s*([\d.]+)\]/g
  )) {
    entries[m[1]] = [parseFloat(m[2]), parseFloat(m[3])];
  }
  return entries;
}

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

    it('matches the prices ported from agentModeService.estimateCost()', () => {
      const ported = parseEstimateCostPricing();
      expect(Object.keys(ported).length).toBeGreaterThanOrEqual(11);
      for (const [model, [inPerM, outPerM]] of Object.entries(ported)) {
        const price = MODEL_PRICING[model];
        expect(price).toBeDefined();
        expect(price.inPerM).toBe(inPerM);
        expect(price.outPerM).toBe(outPerM);
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
      expect(VIDEO_GENERATION_PRICING_USD_PER_CLIP['seedance-2.0']).toBe(0.5);
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
      expectRate('gpt-5.2-chat', 1.75, 14);
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

    it('prices the Pro image model above the flash tier', () => {
      expect(IMAGE_GENERATION_PRICING_USD['gemini-3-pro-image-preview']).toBe(0.134);
    });
  });

  describe('getModelPrice', () => {
    it('returns the price entry for a known model', () => {
      const price = getModelPrice('anthropic.claude-sonnet-4-6');
      expect(price).not.toBeNull();
      expect(price!.inPerM).toBe(3);
      expect(price!.outPerM).toBe(15);
      expect(price!.cacheReadPerM).toBeCloseTo(0.3, 10);
      expect(price!.cacheWritePerM).toBeCloseTo(3.75, 10);
    });

    it('derives cache prices as 10% / 125% of input price for token models', () => {
      for (const [model, price] of Object.entries(MODEL_PRICING)) {
        if (price.outPerM === 0) continue; // embeddings have no cache convention
        expect(price.cacheReadPerM).toBeCloseTo(price.inPerM * 0.1, 10);
        expect(price.cacheWritePerM).toBeCloseTo(price.inPerM * 1.25, 10);
        expect(model).toBeTruthy();
      }
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
});
