import { classifyMetaBudgetChange, priorBudgetForComparison } from '../services/agentMode/metaBudgetAnomaly';

describe('classifyMetaBudgetChange (same currency unit)', () => {
  it.each([
    [190, 'normal', 1.9], [200, 'normal', 2], [210, 'warning', 2.1],
    [1000, 'warning', 10], [1010, 'critical', 10.1], [10000, 'critical', 100],
    [50, 'normal', 0.5],
  ])('%s against 100 is %s', (proposed, severity, ratio) => {
    expect(classifyMetaBudgetChange('100', proposed)).toMatchObject({ severity, ratio });
  });
  it('requires critical review for an increase from zero', () => {
    expect(classifyMetaBudgetChange('0', 100)).toMatchObject({ severity: 'critical', ratio: null });
  });
  it.each([undefined, null, '', ' ', 'NaN', true, {}, [], -1, Infinity])('does not coerce invalid amount %p', value => {
    expect(classifyMetaBudgetChange(value, 100).severity).toBe('unknown');
    expect(classifyMetaBudgetChange(100, value).severity).toBe('unknown');
  });
});

describe('priorBudgetForComparison — adding a budget to an object that had none (Zoma/Haven)', () => {
  it('a read-back campaign with no daily or lifetime budget compares from 0, so the add is classified (not META_BUDGET_UNVERIFIED)', () => {
    const prior = { id: '120', name: 'Haven launch' };
    expect(priorBudgetForComparison(prior, 'daily_budget')).toBe(0);
    expect(priorBudgetForComparison(prior, 'lifetime_budget')).toBe(0);
    // Still subject to the normal review: 0 -> new is a critical increase that needs confirmation.
    expect(classifyMetaBudgetChange(priorBudgetForComparison(prior, 'daily_budget'), 5000)).toMatchObject({ severity: 'critical', ratio: null });
  });

  it('treats null / empty-string budgets from Graph the same as absent', () => {
    expect(priorBudgetForComparison({ id: '1', daily_budget: null, lifetime_budget: '' }, 'daily_budget')).toBe(0);
  });

  it('keeps an existing budget as the prior', () => {
    expect(priorBudgetForComparison({ id: '1', daily_budget: '2500' }, 'daily_budget')).toBe('2500');
  });

  it('stays unknown when the read failed (no id) or the object has the other budget type', () => {
    expect(priorBudgetForComparison(undefined, 'daily_budget')).toBeUndefined();
    expect(priorBudgetForComparison({}, 'daily_budget')).toBeUndefined();
    expect(classifyMetaBudgetChange(priorBudgetForComparison({}, 'daily_budget'), 5000).severity).toBe('unknown');
    expect(priorBudgetForComparison({ id: '1', lifetime_budget: '90000' }, 'daily_budget')).toBeUndefined();
  });
});
