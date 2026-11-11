import {
  classifyFinishedRun,
  proposeRunCredit,
  DEFAULT_CREDIT_POLICY,
  CreditPolicyConfig,
  RunToolEffect,
} from '../truncatedRunCredit';

const lpWrite: RunToolEffect = { tool: 'edit_landing_page', mutating: true, succeeded: true };
const failedWrite: RunToolEffect = { tool: 'edit_landing_page', mutating: true, succeeded: false };
const read: RunToolEffect = { tool: 'get_landing_page', mutating: false, succeeded: true };

describe('classifyFinishedRun (ENG-2888)', () => {
  it('completed run', () => {
    expect(classifyFinishedRun({ terminationReason: 'completed', effects: [read, lpWrite] })).toBe('completed');
    expect(classifyFinishedRun({})).toBe('completed');
  });

  it('iteration-limit exit with no mutating effect is truncated', () => {
    expect(classifyFinishedRun({ terminationReason: 'iteration_limit', effects: [read, failedWrite] })).toBe(
      'truncated_iteration_limit',
    );
  });

  it('iteration-limit exit with partial LP writes is failed_after_partial_effect', () => {
    expect(classifyFinishedRun({ terminationReason: 'iteration_limit', effects: [read, lpWrite] })).toBe(
      'failed_after_partial_effect',
    );
  });

  it('failed run before any effect', () => {
    expect(classifyFinishedRun({ failed: true, effects: [read] })).toBe('failed_before_effect');
    expect(classifyFinishedRun({ terminationReason: 'error' })).toBe('failed_before_effect');
  });

  it('failed run after partial effect', () => {
    expect(classifyFinishedRun({ terminationReason: 'cancelled', effects: [lpWrite] })).toBe(
      'failed_after_partial_effect',
    );
  });
});

describe('proposeRunCredit (ENG-2888)', () => {
  const runs = [
    { terminationReason: 'completed' },
    { terminationReason: 'iteration_limit' },
    { terminationReason: 'iteration_limit', effects: [lpWrite] },
    { failed: true },
    { failed: true, effects: [lpWrite] },
  ];

  it('default config charges full for every class (zero behaviour change)', () => {
    const classes = new Set(runs.map((r) => proposeRunCredit(r).runClass));
    expect(classes.size).toBe(4);
    for (const r of runs) expect(proposeRunCredit(r).treatment).toBe('charge_full');
    expect(Object.values(DEFAULT_CREDIT_POLICY).every((t) => t === 'charge_full')).toBe(true);
  });

  it('custom config maps classes to treatments', () => {
    const cfg: CreditPolicyConfig = {
      completed: 'charge_full',
      truncated_iteration_limit: 'charge_consumed_only',
      failed_before_effect: 'waive',
      failed_after_partial_effect: 'charge_consumed_only',
    };
    expect(proposeRunCredit({ failed: true }, cfg)).toEqual({ runClass: 'failed_before_effect', treatment: 'waive' });
    expect(proposeRunCredit({ terminationReason: 'iteration_limit', effects: [lpWrite] }, cfg).treatment).toBe(
      'charge_consumed_only',
    );
  });
});
