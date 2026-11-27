import { evaluateMetaSpendCeiling, SPEND_CEILING_RAISE_PATH } from '../services/agentMode/metaSpendCeiling';

describe('evaluateMetaSpendCeiling (ENG-2046 A4)', () => {
  it('allows everything when no policy is configured', () => {
    expect(evaluateMetaSpendCeiling(undefined, { field: 'daily_budget', proposed: 10_000_000 })).toEqual({ allowed: true });
    expect(evaluateMetaSpendCeiling({}, { field: 'daily_budget', proposed: 10_000_000 })).toEqual({ allowed: true });
  });

  it('allows a daily budget at the ceiling and rejects one above it with the raise path', () => {
    const policy = { maxDailyBudget: 50_000 };
    expect(evaluateMetaSpendCeiling(policy, { field: 'daily_budget', proposed: 50_000 })).toEqual({ allowed: true });
    const verdict = evaluateMetaSpendCeiling(policy, { field: 'daily_budget', proposed: '50001' });
    expect(verdict).toMatchObject({ allowed: false, code: 'SPEND_CEILING_EXCEEDED', ceiling: 'maxDailyBudget' });
    if (!verdict.allowed) {
      expect(verdict.message).toContain('50000');
      expect(verdict.message).toContain(SPEND_CEILING_RAISE_PATH);
    }
  });

  it('applies the daily ceiling only to daily_budget', () => {
    expect(evaluateMetaSpendCeiling({ maxDailyBudget: 100 }, { field: 'lifetime_budget', proposed: 10_000 })).toEqual({ allowed: true });
  });

  it.each([
    [300, 100, true], [301, 100, false], [100, 1000, true],
  ])('ratio ceiling 3x: %s from %s allowed=%s', (proposed, prior, allowed) => {
    expect(evaluateMetaSpendCeiling({ maxChangeRatio: 3 }, { field: 'spend_cap', proposed, prior }).allowed).toBe(allowed);
  });

  it.each([
    ['lifetime_budget', { maxDailyBudget: 50_000, maxChangeRatio: 2 }],
    ['spend_cap', { maxDailyBudget: 50_000, maxChangeRatio: 2 }],
    ['daily_budget', { maxChangeRatio: 2 }],
  ] as const)('still refuses %s 0 -> X when no cap applies (policy %j)', (field, policy) => {
    expect(evaluateMetaSpendCeiling(policy, { field, proposed: 5_000, prior: 0 }))
      .toMatchObject({ allowed: false, code: 'SPEND_CEILING_EXCEEDED', ceiling: 'maxChangeRatio' });
  });

  it('skips the ratio check for a zero-prior daily_budget when maxDailyBudget caps it', () => {
    const policy = { maxDailyBudget: 50_000, maxChangeRatio: 2 };
    expect(evaluateMetaSpendCeiling(policy, { field: 'daily_budget', proposed: 5_000, prior: 0 })).toEqual({ allowed: true });
    expect(evaluateMetaSpendCeiling(policy, { field: 'daily_budget', proposed: 60_000, prior: 0 }))
      .toMatchObject({ allowed: false, code: 'SPEND_CEILING_EXCEEDED', ceiling: 'maxDailyBudget' });
    expect(evaluateMetaSpendCeiling(policy, { field: 'daily_budget', proposed: '5000', prior: '0' })).toEqual({ allowed: true });
    // a non-zero prior is still ratio-checked
    expect(evaluateMetaSpendCeiling(policy, { field: 'daily_budget', proposed: 1_001, prior: 500 }))
      .toMatchObject({ allowed: false, ceiling: 'maxChangeRatio' });
  });

  it('blocks a 100x attempt rather than letting it through silently', () => {
    expect(evaluateMetaSpendCeiling({ maxChangeRatio: 5 }, { field: 'budget_amount', proposed: 30_000, prior: 300 }))
      .toMatchObject({ allowed: false, code: 'SPEND_CEILING_EXCEEDED' });
  });

  it('skips the ratio check when there is no prior value (create)', () => {
    expect(evaluateMetaSpendCeiling({ maxChangeRatio: 2 }, { field: 'daily_budget', proposed: 999 })).toEqual({ allowed: true });
  });

  it.each([undefined, null, '', 'abc', -1, Infinity, {}])('fails closed on invalid proposed amount %p', proposed => {
    expect(evaluateMetaSpendCeiling({ maxDailyBudget: 100 }, { field: 'daily_budget', proposed }))
      .toMatchObject({ allowed: false, code: 'SPEND_CEILING_INVALID' });
  });

  it.each([0, -5, NaN, '100' as unknown as number])('fails closed on a malformed policy limit %p', limit => {
    expect(evaluateMetaSpendCeiling({ maxDailyBudget: limit }, { field: 'daily_budget', proposed: 1 }))
      .toMatchObject({ allowed: false, code: 'SPEND_CEILING_INVALID' });
    expect(evaluateMetaSpendCeiling({ maxChangeRatio: limit }, { field: 'daily_budget', proposed: 1, prior: 1 }))
      .toMatchObject({ allowed: false, code: 'SPEND_CEILING_INVALID' });
  });

  it('fails closed on an unreadable prior when a ratio ceiling is set', () => {
    expect(evaluateMetaSpendCeiling({ maxChangeRatio: 2 }, { field: 'daily_budget', proposed: 10, prior: 'x' }))
      .toMatchObject({ allowed: false, code: 'SPEND_CEILING_INVALID' });
  });
});
