/**
 * ENG-1886 — the admin screen shows the enforcer's own pause decision.
 *
 * describeEnforcement must only RE-LABEL what checkTokenUsage returned (AC2):
 * if it computed anything, the screen and the gate could disagree about
 * "paused", which is what ENG-1135 consolidated away.
 */
import { describeEnforcement, firstDayOfNextMonth } from '../services/enforcementStateView';
import type { TokenUsageStatus } from '../services/tokenUsageService';

const status = (over: Partial<TokenUsageStatus> = {}): TokenUsageStatus => ({
  allowed: true,
  warning: false,
  used: 1_000_000,
  allowance: 3_000_000,
  bonus: 0,
  effectiveAllowance: 3_000_000,
  percentUsed: 33.3,
  month: '2026-09',
  costUsed: 187.23,
  costAllowance: 200,
  costPercentUsed: 93.6,
  costEnforced: true,
  usageMode: 'full_choice',
  usagePolicyVersion: 'v3',
  alertThresholds: {} as any,
  ...over,
});

describe('describeEnforcement (ENG-1886)', () => {
  it('AC1/AC2: paused is exactly the enforcer\'s refusal — nothing recomputed', () => {
    // Deliberately inconsistent inputs: 50% used but refused. A recomputation
    // would call this "not paused"; the enforcer said otherwise, and it wins.
    expect(describeEnforcement(status({ allowed: false, costPercentUsed: 50 }), '2026-09')).toMatchObject({
      available: true,
      paused: true,
      percentUsed: 50,
    });
    expect(describeEnforcement(status({ allowed: true, costPercentUsed: 140 }), '2026-09')).toMatchObject({
      paused: false,
    });
  });

  it('reports the counter and threshold in dollars when the cost cap gates', () => {
    expect(describeEnforcement(status(), '2026-09')).toEqual({
      available: true,
      month: '2026-09',
      paused: false,
      usageMode: 'full_choice',
      gatedBy: 'cost',
      used: 187.23,
      limit: 200,
      percentUsed: 93.6,
      resetsOn: '2026-10-01',
      usagePolicyVersion: 'v3',
    });
  });

  it('reports token counts when the token cap gates, and "none" when there is no cap', () => {
    expect(describeEnforcement(status({ costEnforced: false }), '2026-09')).toMatchObject({
      gatedBy: 'tokens',
      used: 1_000_000,
      limit: 3_000_000,
      percentUsed: 33.3,
    });
    expect(describeEnforcement(status({ costEnforced: false, effectiveAllowance: null }), '2026-09')).toMatchObject({
      gatedBy: 'none',
      limit: null,
    });
  });

  it('never infers a pause for a past month — the enforcer only knows the current one', () => {
    expect(describeEnforcement(status({ allowed: false }), '2026-08')).toEqual({
      available: false,
      reason: 'not-current-month',
      currentMonth: '2026-09',
    });
  });

  it('resets on the first day of the next month, across a year boundary', () => {
    expect(firstDayOfNextMonth('2026-09')).toBe('2026-10-01');
    expect(firstDayOfNextMonth('2026-12')).toBe('2027-01-01');
  });
});
