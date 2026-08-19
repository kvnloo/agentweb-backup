import { resolveCrmEnrichmentModel } from '../services/crmEnrichmentPolicyAdapter';

const policy = {
  version: 'v1',
  enforcementState: 'enforce' as const,
  optimizationCostThresholdMicroUsd: 100,
  hardCostThresholdMicroUsd: 200,
  optimizedModelIds: ['gemini-2.5-flash'],
  optimizedDefaultModel: 'gemini-2.5-flash',
};

describe('resolveCrmEnrichmentModel', () => {
  it('honors an allowed model below the optimization threshold', () => {
    expect(resolveCrmEnrichmentModel({ requestedModel: 'gpt-5-chat-2', systemDefaultModel: 'gpt-5-chat-2', supportedModelIds: ['gpt-5-chat-2'], policy, usageMode: 'full_choice' }).effectiveModel).toBe('gpt-5-chat-2');
  });

  it('corrects an unsupported requested model to the system default (ENG-1211: no optimized substitution)', () => {
    const result = resolveCrmEnrichmentModel({ requestedModel: 'unsupported-model', systemDefaultModel: 'gpt-5-chat-2', supportedModelIds: ['gpt-5-chat-2', 'gemini-2.5-flash'], policy, usageMode: 'full_choice' });
    expect(result.effectiveModel).toBe('gpt-5-chat-2');
    expect(result.modelSelection).toBe('corrected');
  });

  it('blocks provider calls when the hard cap pauses usage', () => {
    const result = resolveCrmEnrichmentModel({ requestedModel: 'gpt-5-chat-2', systemDefaultModel: 'gpt-5-chat-2', supportedModelIds: ['gpt-5-chat-2'], policy, usageMode: 'paused' });
    expect(result.effectiveModel).toBeNull();
    expect(result.modelSelection).toBe('blocked');
  });

  it('returns a policy-selected fallback only when it is allowed', () => {
    const result = resolveCrmEnrichmentModel({ requestedModel: 'gpt-5-chat-2', backupModel: 'gemini-2.5-flash', backupSource: 'system', systemDefaultModel: 'gpt-5-chat-2', supportedModelIds: ['gpt-5-chat-2', 'gemini-2.5-flash'], policy, usageMode: 'optimized' });
    expect(result.backupModel).toBe('gemini-2.5-flash');
  });
});
