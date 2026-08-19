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
});
