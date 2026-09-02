/**
 * ENG-1691 — one API call, one ledger row.
 *
 * `imageGeneration.ts` builds its provider client through the METERED factories
 * (`getGeminiClient({ feature: 'content_gen' })`), which token-meter everything
 * they serve. Image models carry no token rate, so that wrote a $0 row beside
 * the real per-generation row recorded at `imageGeneration.ts:562` — two entries
 * for one call, on models that generate no text.
 *
 * Measured in production before the fix: 368 `content_gen` calls against 348
 * `image_generation` calls on the same two models over the same window, ~1M
 * tokens attributed to content generation that produced none. Every per-feature
 * cut inherits that — ENG-1213's driver attribution and ENG-1139's unit
 * economics both group by `feature`.
 *
 * `llmClients.ts:243` already stated the rule ("NOT for image/video, which are
 * per-generation priced"). It was a comment, so it was not enforced.
 */

const mockIncrementUsage = jest.fn();
jest.mock('../services/usageRecordDb', () => ({
  ...jest.requireActual('../services/usageRecordDb'),
  usageRecordDb: { incrementUsage: (...a: any[]) => mockIncrementUsage(...a) },
}));

import { recordUsage } from '../services/usageRecorderService';
import { isPerGenerationPriced, imageGenerationCostUsd } from '../utils/llmPricing';

beforeEach(() => jest.clearAllMocks());

describe('isPerGenerationPriced', () => {
  it('recognises image and video models', () => {
    expect(isPerGenerationPriced('gemini-3-pro-image-preview')).toBe(true);
    expect(isPerGenerationPriced('gemini-3.1-flash-image')).toBe(true);
    expect(isPerGenerationPriced('gpt-image-1')).toBe(true);
  });
  it('does not claim token-priced or unknown models', () => {
    expect(isPerGenerationPriced('gpt-5.4')).toBe(false);
    expect(isPerGenerationPriced('anthropic.claude-opus-5')).toBe(false);
    expect(isPerGenerationPriced('totally-made-up-model')).toBe(false);
    expect(isPerGenerationPriced(undefined)).toBe(false);
    expect(isPerGenerationPriced('')).toBe(false);
  });
});

describe('ENG-1691 — a per-generation model is not token-metered', () => {
  it('drops the shadow row a metered client would have written', async () => {
    await recordUsage({
      userId: 'u1', model: 'gemini-3-pro-image-preview',
      provider: 'gemini', feature: 'content_gen',
      inputTokens: 1200, outputTokens: 8400,
    } as any);
    expect(mockIncrementUsage).not.toHaveBeenCalled();
  });

  it('still records the REAL per-generation row, which carries an override', async () => {
    await recordUsage({
      userId: 'u1', model: 'gemini-3-pro-image-preview',
      provider: 'gemini', feature: 'image_generation',
      inputTokens: 0, outputTokens: 0,
      costUsdOverride: imageGenerationCostUsd('gemini-3-pro-image-preview'),
    } as any);
    expect(mockIncrementUsage).toHaveBeenCalledTimes(1);
    const row = mockIncrementUsage.mock.calls[0][0];
    expect(row.feature).toBe('image_generation');
    expect(row.costMicroUsd).toBe(134_000);   // $0.134
    expect(row.costSource).toBe('allocated');
  });

  it('keys on the override, not the feature name — a relabelled caller cannot slip through', async () => {
    // The same suppression must apply whatever the feature is called; only the
    // presence of a real per-generation cost distinguishes the legitimate row.
    await recordUsage({
      userId: 'u1', model: 'gpt-image-1', provider: 'openai',
      feature: 'image_generation', inputTokens: 500, outputTokens: 0,
    } as any);
    expect(mockIncrementUsage).not.toHaveBeenCalled();
  });
});

describe('ENG-700 is not weakened by the fix', () => {
  it('a model in NEITHER price book still records, and still tags unpriced', async () => {
    await recordUsage({
      userId: 'u1', model: 'brand-new-unpriced-model',
      provider: 'gemini', feature: 'agent_task',
      inputTokens: 1000, outputTokens: 2000,
    } as any);
    expect(mockIncrementUsage).toHaveBeenCalledTimes(1);
    const row = mockIncrementUsage.mock.calls[0][0];
    expect(row.costSource).toBe('unpriced');
    expect(row.costMicroUsd).toBe(0);
    expect(row.totalTokens ?? row.inputTokens + row.outputTokens).toBeGreaterThan(0);
  });

  it('a token-priced model is unaffected', async () => {
    await recordUsage({
      userId: 'u1', model: 'gpt-5.4', provider: 'openai',
      feature: 'agent_task', inputTokens: 1000, outputTokens: 1000,
    } as any);
    expect(mockIncrementUsage).toHaveBeenCalledTimes(1);
    expect(mockIncrementUsage.mock.calls[0][0].costSource).toBe('allocated');
  });
});
