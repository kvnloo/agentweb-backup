import {
  getActiveLlmUsageTopUpPackages,
  resolveLlmUsageTopUpPackage,
  validateLlmUsageTopUpConfig,
  type LlmUsageTopUpConfig,
} from '../services/llmUsageTopUpService';

const config: LlmUsageTopUpConfig = {
  enabled: true,
  minimumMarkupBps: 25_000,
  packages: [
    { id: 'aw-10', label: '10 AgentWeb Credits', priceCents: 2_500, usageCreditMicroUsd: 10_000_000, active: true },
    { id: 'hidden', label: 'Hidden', priceCents: 5_000, usageCreditMicroUsd: 10_000_000, active: false },
  ],
};

describe('LLM usage top-up config', () => {
  it('accepts an admin-configured 2.5x package without exposing provider cost', () => {
    expect(validateLlmUsageTopUpConfig(config)).toEqual([]);
    expect(getActiveLlmUsageTopUpPackages(config)).toEqual([config.packages[0]]);
  });

  it('rejects any package below the admin-configured minimum markup', () => {
    expect(validateLlmUsageTopUpConfig({
      ...config,
      packages: [{ ...config.packages[0], priceCents: 2_499 }],
    })).toContain('packages[0] is below minimumMarkupBps');
  });

  it('resolves only active packages by stable id', () => {
    expect(resolveLlmUsageTopUpPackage(config, 'aw-10')).toEqual(config.packages[0]);
    expect(resolveLlmUsageTopUpPackage(config, 'hidden')).toBeNull();
  });
});
