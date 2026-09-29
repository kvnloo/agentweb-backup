import { highConfidenceAgreement, routeShadowTask } from '../experiments/shadowRouteExperiment';

describe('A7 shadow route experiment', () => {
  it('routes bounded exact-tool work locally', () => {
    expect(routeShadowTask({
      estimatedInputTokens: 1200,
      exactToolMatch: true,
    })).toMatchObject({ route: 'local', confidence: 0.98 });
  });

  it('keeps fresh external research on the frontier path', () => {
    expect(routeShadowTask({
      estimatedInputTokens: 800,
      requiresFreshWeb: true,
    })).toMatchObject({ route: 'frontier', confidence: 0.98 });
  });

  it('abstains on destructive or ambiguous tasks', () => {
    expect(routeShadowTask({ estimatedInputTokens: 500, destructiveWrite: true }).route).toBe('abstain');
    expect(routeShadowTask({ estimatedInputTokens: 500, ambiguous: true }).route).toBe('abstain');
  });

  it('scores high-confidence fixtures separately from abstentions', () => {
    const agreement = highConfidenceAgreement([
      { task: { estimatedInputTokens: 1000, exactToolMatch: true }, expected: 'local' },
      { task: { estimatedInputTokens: 2000, exactToolMatch: true }, expected: 'local' },
      { task: { estimatedInputTokens: 500, requiresFreshWeb: true }, expected: 'frontier' },
      { task: { estimatedInputTokens: 900, requiresFreshWeb: true }, expected: 'frontier' },
    ]);

    expect(agreement).toBe(1);
  });
});
