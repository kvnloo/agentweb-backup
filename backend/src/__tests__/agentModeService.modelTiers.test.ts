import { AgentModeService, tierFromCostScore, tierFromQualityScore } from '../services/agentModeService';
import * as llmPricing from '../utils/llmPricing';

// Pins the exact band boundaries (revised 2026-08-19, three times in one
// session — this is why a direct unit test exists now instead of only
// being covered incidentally through registry-level tests). Re-cut
// 2026-09-05 (ENG-1784), Harsha: Flagship ("frontier") is everything 64 and
// up — so GPT-5.6 Sol (71) and Claude Opus 5 (70) share it — Pro 58–63,
// Medium 53–57, Cheap 31–52, Very Cheap unchanged (≤30).
describe('tierFromCostScore', () => {
  it('matches the documented thresholds: 64/58/53/31/0', () => {
    expect(tierFromCostScore(100)).toBe('ultra_premium');
    expect(tierFromCostScore(71)).toBe('ultra_premium'); // GPT-5.6 Sol
    expect(tierFromCostScore(70)).toBe('ultra_premium'); // Claude Opus 5
    expect(tierFromCostScore(64)).toBe('ultra_premium');
    expect(tierFromCostScore(63)).toBe('pro');
    expect(tierFromCostScore(58)).toBe('pro');
    expect(tierFromCostScore(57)).toBe('medium');
    expect(tierFromCostScore(53)).toBe('medium');
    expect(tierFromCostScore(52)).toBe('cheap');
    expect(tierFromCostScore(31)).toBe('cheap');
    expect(tierFromCostScore(30)).toBe('ultra_cheap');
    expect(tierFromCostScore(0)).toBe('ultra_cheap');
  });
});

// ENG-1789 (2026-09-06), Harsha: "fable + astra are flagship, opus + 5.6 sol
// are pro, sonnet + 5.6 terra are mid, haiku + 5.6 luna are low" — a
// SEPARATE axis from cost. Thresholds solved against the live AA v4.2
// qualityScores of those 8 named models (Fable 57, Astra 55, Opus 5 54,
// Sol 51, Sonnet 5 45, Terra 47, Haiku 17, Luna 43); ties resolve to the
// higher band (Harsha, 2026-09-06).
describe('tierFromQualityScore', () => {
  // Re-cut 2026-09-22 for AA v4.3.2 (scores run ~5-8 points below v4.2).
  it('matches the documented thresholds: 53/47/38/15/0', () => {
    expect(tierFromQualityScore(100)).toBe('ultra_premium');
    expect(tierFromQualityScore(58)).toBe('ultra_premium'); // Claude Opus 5.5
    expect(tierFromQualityScore(53)).toBe('ultra_premium'); // Claude Fable 5.1 / GPT-6 Astra
    expect(tierFromQualityScore(52)).toBe('pro');
    expect(tierFromQualityScore(51)).toBe('pro'); // Claude Opus 5
    expect(tierFromQualityScore(47)).toBe('pro'); // GPT-5.6 Sol
    expect(tierFromQualityScore(46)).toBe('medium');
    expect(tierFromQualityScore(42)).toBe('medium'); // GPT-5.6 Terra
    expect(tierFromQualityScore(38)).toBe('medium'); // Claude Sonnet 5 / GPT-5.6 Luna (tie -> higher band)
    expect(tierFromQualityScore(37)).toBe('cheap');
    expect(tierFromQualityScore(15)).toBe('cheap'); // Claude Haiku 4.5
    expect(tierFromQualityScore(14)).toBe('ultra_cheap');
    expect(tierFromQualityScore(0)).toBe('ultra_cheap');
  });

  it('resolves a tie at the boundary to the higher band', () => {
    // v4.3.2: GPT-5.6 Luna ties Claude Sonnet 5 at 38 — both go to
    // 'medium', not the 'cheap' band one boundary down.
    expect(tierFromQualityScore(38)).toBe('medium');
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
      'internal-only-model': { client: null, supportsTemperature: true, internalOnly: true },
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

  it('excludes internal workload models for both admin and non-admin pickers', async () => {
    const customer = await svc.getSupportedModelsWithMetadata(false);
    const admin = await svc.getSupportedModelsWithMetadata(true);
    expect(customer.some((m: any) => m.id === 'internal-only-model')).toBe(false);
    expect(admin.some((m: any) => m.id === 'internal-only-model')).toBe(false);
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
  // here, that's the frontend meter's job. qualityTier (ENG-1789) is a
  // separate derived field alongside cost-driven tier.
  it('surfaces qualityScore/costScore, qualityTier, and their source notes when present', async () => {
    const result = await svc.getSupportedModelsWithMetadata(false);
    const scored = result.find((m: any) => m.id === 'scored-model');
    const expectedCostScore = llmPricing.costScoreFromPrice(SCORED_MODEL_PRICE);
    expect(scored).toEqual({
      // tier is 'ultra_premium', not the fixture's static 'pro' — once a
      // price is available, tier is derived from the real costScore, and
      // this fixture's price computes to 95 (>=64 -> ultra_premium).
      id: 'scored-model', name: 'Scored Model', tier: 'ultra_premium', description: 'Scored', provider: 'anthropic',
      // qualityScore 96 >= 55 -> 'ultra_premium' on the quality bands too,
      // independently of the cost-derived tier above (they happen to agree
      // here; QUALITY_SCORE_BANDS assertions live in the tierFromQualityScore
      // describe block above).
      qualityTier: 'ultra_premium',
      qualityScore: 96, qualityScoreSource: 'AA Intelligence Index, 2026-08-19',
      costScore: expectedCostScore,
      costScoreSource: expect.any(String),
    });
  });

  // A model with a qualityScore but no cost price still gets a qualityTier —
  // the two axes are independent, so a missing cost score never suppresses it.
  it('computes qualityTier from qualityScore even when costScore is unavailable', async () => {
    svc.llmModels['quality-only-model'] = {
      client: null, supportsTemperature: true,
      tier: 'medium', description: 'Quality only', name: 'Quality Only Model', provider: 'google',
      qualityScore: 45, qualityScoreSource: 'AA Intelligence Index v4.2, snapshot 2026-09-05',
    };
    const result = await svc.getSupportedModelsWithMetadata(false);
    const model = result.find((m: any) => m.id === 'quality-only-model');
    expect(model.qualityTier).toBe('medium');
    expect(model).not.toHaveProperty('costScore');
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
