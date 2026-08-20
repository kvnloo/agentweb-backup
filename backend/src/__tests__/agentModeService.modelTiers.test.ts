import { AgentModeService, tierFromCostScore } from '../services/agentModeService';
import * as llmPricing from '../utils/llmPricing';

// Pins the exact band boundaries (revised 2026-08-19, three times in one
// session — this is why a direct unit test exists now instead of only
// being covered incidentally through registry-level tests).
describe('tierFromCostScore', () => {
  it('matches the documented thresholds: 71/64/51/31/0', () => {
    expect(tierFromCostScore(100)).toBe('ultra_premium');
    expect(tierFromCostScore(71)).toBe('ultra_premium');
    expect(tierFromCostScore(70)).toBe('pro');
    expect(tierFromCostScore(64)).toBe('pro');
    expect(tierFromCostScore(63)).toBe('medium');
    expect(tierFromCostScore(51)).toBe('medium');
    expect(tierFromCostScore(50)).toBe('cheap');
    expect(tierFromCostScore(31)).toBe('cheap');
    expect(tierFromCostScore(30)).toBe('ultra_cheap');
    expect(tierFromCostScore(0)).toBe('ultra_cheap');
  });
});

// costScore is computed live from MODEL_PRICING (via getModelPrice), not
// read off the config — see agentModeService.getSupportedModelsWithMetadata.
// None of this file's fixture ids are real MODEL_PRICING entries, so
// getModelPrice is mocked per-id here; costScoreFromPrice itself stays the
// real implementation (requireActual) so the expected value is computed by
// the genuine formula, not a hand-picked magic number.
jest.mock('../utils/llmPricing', () => ({
  ...jest.requireActual('../utils/llmPricing'),
  getModelPrice: jest.fn(),
}));

const SCORED_MODEL_PRICE = { inPerM: 60, outPerM: 90 };

describe('AgentModeService.getSupportedModelsWithMetadata', () => {
  let svc: any;

  beforeEach(() => {
    (llmPricing.getModelPrice as jest.Mock).mockImplementation((id: string) =>
      id === 'scored-model' ? SCORED_MODEL_PRICE : null,
    );

    svc = Object.create(AgentModeService.prototype);
    svc.llmModels = {
      'tiered-model': {
        client: null, supportsTemperature: true,
        tier: 'pro', description: 'For complex tasks', name: 'Tiered Model', provider: 'anthropic',
      },
      'untiered-model': { client: null, supportsTemperature: true },
      'admin-only-model': {
        client: null, supportsTemperature: true, adminOnly: true,
        tier: 'ultra_premium', description: 'Frontier', name: 'Admin Only Model', provider: 'openai',
      },
      'voice-model': { client: null, supportsTemperature: true, isLive: true, tier: 'medium', description: 'Voice' },
      'legacy-model': {
        client: null, supportsTemperature: true, legacy: true,
        tier: 'medium', description: 'Previous-generation', name: 'Legacy Model', provider: 'anthropic',
      },
      'scored-model': {
        client: null, supportsTemperature: true,
        tier: 'pro', description: 'Scored', name: 'Scored Model', provider: 'anthropic',
        qualityScore: 96, qualityScoreSource: 'AA Intelligence Index, 2026-08-19',
      },
    };
    svc.getSupportedModels = AgentModeService.prototype.getSupportedModels.bind(svc);
    svc.getDefaultModel = jest.fn().mockResolvedValue('tiered-model');
  });

  // FAIL case 1: an untiered/unnamed model must not be dropped or crash the picker —
  // it defaults to medium/generic-description/other-provider, and its display name
  // falls back to the raw id rather than being blank.
  it('defaults an untiered model to medium/generic-description/other-provider, name falling back to the id', async () => {
    const result = await svc.getSupportedModelsWithMetadata(false);
    const untiered = result.find((m: any) => m.id === 'untiered-model');
    expect(untiered).toEqual({
      id: 'untiered-model',
      name: 'untiered-model',
      tier: 'medium',
      description: 'General-purpose model',
      provider: 'other',
    });
  });

  // FAIL case 2: adminOnly filtering must still apply for non-admin callers.
  it('excludes adminOnly models for a non-admin caller', async () => {
    const result = await svc.getSupportedModelsWithMetadata(false);
    expect(result.some((m: any) => m.id === 'admin-only-model')).toBe(false);
  });

  // FAIL case 3: a live-voice model must never appear in the text-chat picker.
  it('excludes isLive (voice) models regardless of admin status', async () => {
    const result = await svc.getSupportedModelsWithMetadata(true);
    expect(result.some((m: any) => m.id === 'voice-model')).toBe(false);
  });

  // SUCCESS case: a tiered model returns its real tier/description/name/provider (not
  // guessed from the id), and adminOnly models are included for an admin caller with
  // the same full metadata.
  it('returns real tier/description/name/provider for a tiered model, and includes adminOnly for admins', async () => {
    const result = await svc.getSupportedModelsWithMetadata(true);
    const tiered = result.find((m: any) => m.id === 'tiered-model');
    expect(tiered).toEqual({
      id: 'tiered-model', name: 'Tiered Model', tier: 'pro', description: 'For complex tasks', provider: 'anthropic',
    });
    const admin = result.find((m: any) => m.id === 'admin-only-model');
    expect(admin).toEqual({
      id: 'admin-only-model', name: 'Admin Only Model', tier: 'ultra_premium', description: 'Frontier', provider: 'openai',
    });
  });

  // FAIL case 4: a superseded-version model must carry `legacy: true` so the
  // frontend can tuck it behind "Show more" instead of listing it inline —
  // it still appears in the full result (never dropped/adminOnly-hidden by
  // this flag alone), just annotated.
  it('marks a legacy model with legacy: true, and never marks a current model with it', async () => {
    const result = await svc.getSupportedModelsWithMetadata(false);
    const legacy = result.find((m: any) => m.id === 'legacy-model');
    expect(legacy).toEqual({
      id: 'legacy-model', name: 'Legacy Model', tier: 'medium', description: 'Previous-generation',
      provider: 'anthropic', legacy: true,
    });
    // Non-legacy models omit the key entirely rather than set it false —
    // asserted on the existing 'tiered-model' fixture above.
    const current = result.find((m: any) => m.id === 'tiered-model');
    expect(current).not.toHaveProperty('legacy');
  });

  // FAIL case 5: a model with real quality/cost scores must surface them
  // (and their source notes) to the picker — never rounded/reinterpreted
  // here, that's the frontend meter's job.
  it('surfaces qualityScore/costScore and their source notes when present', async () => {
    const result = await svc.getSupportedModelsWithMetadata(false);
    const scored = result.find((m: any) => m.id === 'scored-model');
    const expectedCostScore = llmPricing.costScoreFromPrice(SCORED_MODEL_PRICE);
    expect(scored).toEqual({
      // tier is 'ultra_premium', not the fixture's static 'pro' — once a
      // price is available, tier is derived from the real costScore, and
      // this fixture's price computes to 95 (>=71 -> ultra_premium).
      id: 'scored-model', name: 'Scored Model', tier: 'ultra_premium', description: 'Scored', provider: 'anthropic',
      qualityScore: 96, qualityScoreSource: 'AA Intelligence Index, 2026-08-19',
      costScore: expectedCostScore,
      costScoreSource: expect.any(String),
    });
  });

  // A model with no scores omits the keys entirely (never a guessed 0 or null).
  it('omits qualityScore/costScore entirely — never a guessed value — when a model has neither', async () => {
    const result = await svc.getSupportedModelsWithMetadata(false);
    const tiered = result.find((m: any) => m.id === 'tiered-model');
    expect(tiered).not.toHaveProperty('qualityScore');
    expect(tiered).not.toHaveProperty('qualityScoreSource');
    expect(tiered).not.toHaveProperty('costScore');
    expect(tiered).not.toHaveProperty('costScoreSource');
  });
});
