import { evaluateAllowanceThresholds } from '../allowanceThresholds';

const month = '2026-11';

describe('evaluateAllowanceThresholds (ENG-2821)', () => {
  it('returns nothing below 75%', () => {
    expect(evaluateAllowanceThresholds({ usedUsd: 59, allowanceUsd: 80, billingMonth: month, alreadyFired: [] })).toEqual([]);
  });

  it('fires 75% once, then not again the same month', () => {
    expect(evaluateAllowanceThresholds({ usedUsd: 60, allowanceUsd: 80, billingMonth: month, alreadyFired: [] })).toEqual([0.75]);
    expect(
      evaluateAllowanceThresholds({
        usedUsd: 65,
        allowanceUsd: 80,
        billingMonth: month,
        alreadyFired: [{ billingMonth: month, threshold: 0.75 }],
      }),
    ).toEqual([]);
  });

  it('a jump past both thresholds returns both', () => {
    expect(evaluateAllowanceThresholds({ usedUsd: 75, allowanceUsd: 80, billingMonth: month, alreadyFired: [] })).toEqual([0.75, 0.9]);
  });

  it('a new billing month resets fired thresholds', () => {
    expect(
      evaluateAllowanceThresholds({
        usedUsd: 75,
        allowanceUsd: 80,
        billingMonth: '2026-12',
        alreadyFired: [
          { billingMonth: month, threshold: 0.75 },
          { billingMonth: month, threshold: 0.9 },
        ],
      }),
    ).toEqual([0.75, 0.9]);
  });

  it('allowance 0 or undefined returns none', () => {
    expect(evaluateAllowanceThresholds({ usedUsd: 100, allowanceUsd: 0, billingMonth: month, alreadyFired: [] })).toEqual([]);
    expect(evaluateAllowanceThresholds({ usedUsd: 100, billingMonth: month, alreadyFired: [] })).toEqual([]);
  });

  it('Opiner: 98% of $80 with 75% already fired returns only 90%', () => {
    expect(
      evaluateAllowanceThresholds({
        usedUsd: 78.4,
        allowanceUsd: 80,
        billingMonth: month,
        alreadyFired: [{ billingMonth: month, threshold: 0.75 }],
      }),
    ).toEqual([0.9]);
    expect(evaluateAllowanceThresholds({ usedUsd: 78.4, allowanceUsd: 80, billingMonth: month, alreadyFired: [] })).toEqual([0.75, 0.9]);
  });
});
