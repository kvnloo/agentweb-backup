import { compareLifecycleModels, staleClassificationRate } from '../experiments/lifecycleModelExperiment';

const NOW = new Date('2026-09-29T18:00:00.000Z');

describe('A1 lifecycle model experiment', () => {
  it('shows a stored inbox snapshot going stale after the lead starts paying', () => {
    const result = compareLifecycleModels({
      email: 'a@example.com',
      storedLifecycle: 'inbox',
      subscriptionState: 'active',
    }, NOW);

    expect(result.storedModel).toBe('inbox');
    expect(result.derivedModel).toBe('paying');
    expect(result.diverged).toBe(true);
  });

  it('shows why persisted lifecycle is_empty is unsafe for derived state', () => {
    const result = compareLifecycleModels({
      email: 'a@example.com',
      storedLifecycle: null,
    }, NOW);

    expect(result.persistedEmpty).toBe(true);
    expect(result.derivedModel).toBe('inbox');
    expect(result.derivedEmpty).toBe(false);
  });

  it('measures stale classifications across a fixture cohort', () => {
    const rate = staleClassificationRate([
      { email: 'a@example.com', storedLifecycle: 'inbox', subscriptionState: 'active' },
      { email: 'b@example.com', storedLifecycle: 'inbox' },
      { email: 'c@example.com', storedLifecycle: 'paying', subscriptionState: 'past_due' },
    ], NOW);

    expect(rate).toBeCloseTo(2 / 3);
  });
});
