import { AgentModeService } from '../services/agentModeService';

describe('AgentModeService.getSupportedModelsWithMetadata', () => {
  let svc: any;

  beforeEach(() => {
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
        costScore: 95, costScoreSource: 'Pricing snapshot 2026-08-19',
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
    expect(scored).toEqual({
      id: 'scored-model', name: 'Scored Model', tier: 'pro', description: 'Scored', provider: 'anthropic',
      qualityScore: 96, qualityScoreSource: 'AA Intelligence Index, 2026-08-19',
      costScore: 95, costScoreSource: 'Pricing snapshot 2026-08-19',
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
