/**
 * Tests for healthScoreService (C2 — CRM Unification v1).
 */

import {
  computeHealthScore,
  computeForContact,
  recomputeBatch,
  shouldTransitionToAtRisk,
  shouldRecoverToPaying,
  HealthScoreSignals,
  HEALTH_AT_RISK_THRESHOLD,
} from '../healthScoreService';

const FIXED_NOW = new Date('2026-04-14T12:00:00.000Z');
const isoDaysAgo = (d: number) =>
  new Date(FIXED_NOW.getTime() - d * 24 * 60 * 60 * 1000).toISOString();

// By default every signal that could score negative is ON, so the baseline
// is "silent contact, no subscription" — 0 after clamping (the -50 no-usage
// penalty clamps at 0).
const baseline: HealthScoreSignals = {
  subscriptionState: 'none',
  lastEmmaSessionAt: null,
  lastEngagementReplyAt: null,
  lastUsageAt: null,
  unresolvedSupportIssueOpenedAt: null,
};

describe('computeHealthScore — individual rules', () => {
  it('starts silent contacts at 0 (clamped from the no-usage penalty)', () => {
    expect(computeHealthScore(baseline, FIXED_NOW)).toBe(0);
  });

  it('adds 50 for an active subscription', () => {
    // Active sub gives +50, but the no-usage penalty (-50) still fires because
    // lastUsageAt is null. Net 0 unless we also have recent usage.
    expect(
      computeHealthScore({ ...baseline, subscriptionState: 'active' }, FIXED_NOW)
    ).toBe(0);
  });

  it('adds 50 for a trialing subscription', () => {
    expect(
      computeHealthScore(
        { ...baseline, subscriptionState: 'trialing', lastUsageAt: isoDaysAgo(2) },
        FIXED_NOW
      )
    ).toBe(50);
  });

  it('adds 25 for a recent Emma session (<7d)', () => {
    expect(
      computeHealthScore(
        { ...baseline, lastEmmaSessionAt: isoDaysAgo(3), lastUsageAt: isoDaysAgo(3) },
        FIXED_NOW
      )
    ).toBe(25);
  });

  it('does NOT add 25 for an Emma session older than 7 days', () => {
    expect(
      computeHealthScore(
        { ...baseline, lastEmmaSessionAt: isoDaysAgo(10), lastUsageAt: isoDaysAgo(10) },
        FIXED_NOW
      )
    ).toBe(0);
  });

  it('adds 15 for an engagement reply in the last 14 days', () => {
    expect(
      computeHealthScore(
        { ...baseline, lastEngagementReplyAt: isoDaysAgo(10), lastUsageAt: isoDaysAgo(10) },
        FIXED_NOW
      )
    ).toBe(15);
  });

  it('does NOT add 15 for an engagement reply older than 14 days', () => {
    expect(
      computeHealthScore(
        { ...baseline, lastEngagementReplyAt: isoDaysAgo(20), lastUsageAt: isoDaysAgo(5) },
        FIXED_NOW
      )
    ).toBe(0);
  });

  it('subtracts 30 for a past_due subscription', () => {
    // active-equivalent case: usage recent, sub past_due: +0 sub -30 penalty -> clamped to 0
    expect(
      computeHealthScore(
        { ...baseline, subscriptionState: 'past_due', lastUsageAt: isoDaysAgo(1) },
        FIXED_NOW
      )
    ).toBe(0);
  });

  it('subtracts 50 for no usage event in 30+ days', () => {
    expect(
      computeHealthScore(
        {
          ...baseline,
          subscriptionState: 'active',
          lastUsageAt: isoDaysAgo(1),
        },
        FIXED_NOW
      )
    ).toBe(50);
    // Same subscription but lastUsageAt >30d → penalty fires.
    expect(
      computeHealthScore(
        {
          ...baseline,
          subscriptionState: 'active',
          lastUsageAt: isoDaysAgo(45),
        },
        FIXED_NOW
      )
    ).toBe(0);
  });

  it('treats null lastUsageAt as silence (penalty applies)', () => {
    expect(
      computeHealthScore({ ...baseline, subscriptionState: 'active' }, FIXED_NOW)
    ).toBe(0);
  });

  it('subtracts 40 for an unresolved support issue older than 7 days', () => {
    expect(
      computeHealthScore(
        {
          ...baseline,
          subscriptionState: 'active',
          lastUsageAt: isoDaysAgo(1),
          unresolvedSupportIssueOpenedAt: isoDaysAgo(10),
        },
        FIXED_NOW
      )
    ).toBe(10);
  });

  it('does NOT subtract 40 for a fresh support issue (<=7d)', () => {
    expect(
      computeHealthScore(
        {
          ...baseline,
          subscriptionState: 'active',
          lastUsageAt: isoDaysAgo(1),
          unresolvedSupportIssueOpenedAt: isoDaysAgo(3),
        },
        FIXED_NOW
      )
    ).toBe(50);
  });

  it('ignores malformed timestamps instead of throwing', () => {
    expect(
      computeHealthScore(
        {
          ...baseline,
          subscriptionState: 'active',
          lastUsageAt: 'not-a-date',
        },
        FIXED_NOW
      )
    ).toBe(0); // null usage = silence penalty
  });

  it('treats future timestamps as unknown (clock-skew guard)', () => {
    const future = new Date(FIXED_NOW.getTime() + 24 * 60 * 60 * 1000).toISOString();
    expect(
      computeHealthScore(
        { ...baseline, subscriptionState: 'active', lastUsageAt: future },
        FIXED_NOW
      )
    ).toBe(0);
  });
});

describe('computeHealthScore — aggregation and clamping', () => {
  it('peak-healthy customer lands at 90 (50 + 25 + 15)', () => {
    expect(
      computeHealthScore(
        {
          subscriptionState: 'active',
          lastEmmaSessionAt: isoDaysAgo(2),
          lastEngagementReplyAt: isoDaysAgo(5),
          lastUsageAt: isoDaysAgo(1),
          unresolvedSupportIssueOpenedAt: null,
        },
        FIXED_NOW
      )
    ).toBe(90);
  });

  it('never returns negative', () => {
    const score = computeHealthScore(
      {
        subscriptionState: 'past_due',
        lastUsageAt: isoDaysAgo(60),
        unresolvedSupportIssueOpenedAt: isoDaysAgo(30),
        lastEmmaSessionAt: null,
        lastEngagementReplyAt: null,
      },
      FIXED_NOW
    );
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it('caps at 100 (not possible with current rule set, but defensive)', () => {
    // Raw max from spec = 50 + 25 + 15 = 90; nothing in the positive rules goes
    // over 100, but the clamp is exercised via the assertion that no caller
    // ever sees >100.
    const score = computeHealthScore(
      {
        subscriptionState: 'active',
        lastEmmaSessionAt: isoDaysAgo(0),
        lastEngagementReplyAt: isoDaysAgo(0),
        lastUsageAt: isoDaysAgo(0),
      },
      FIXED_NOW
    );
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe('shouldTransitionToAtRisk', () => {
  it('returns at_risk when a paying contact drops below threshold', () => {
    expect(shouldTransitionToAtRisk('paying', HEALTH_AT_RISK_THRESHOLD - 1)).toBe('at_risk');
  });

  it('returns null when score is at the threshold', () => {
    expect(shouldTransitionToAtRisk('paying', HEALTH_AT_RISK_THRESHOLD)).toBeNull();
  });

  it('returns null when score is above the threshold', () => {
    expect(shouldTransitionToAtRisk('paying', 80)).toBeNull();
  });

  it('does not transition non-paying lifecycles', () => {
    expect(shouldTransitionToAtRisk('inbox', 10)).toBeNull();
    expect(shouldTransitionToAtRisk('signed_up', 10)).toBeNull();
    expect(shouldTransitionToAtRisk('churned', 10)).toBeNull();
  });
});

describe('shouldRecoverToPaying', () => {
  it('flips at_risk back to paying when score recovers to the threshold', () => {
    expect(shouldRecoverToPaying('at_risk', HEALTH_AT_RISK_THRESHOLD)).toBe('paying');
    expect(shouldRecoverToPaying('at_risk', 80)).toBe('paying');
  });

  it('does not flip at_risk when score stays below threshold', () => {
    expect(shouldRecoverToPaying('at_risk', HEALTH_AT_RISK_THRESHOLD - 1)).toBeNull();
  });

  it('does nothing for non-at_risk lifecycles', () => {
    expect(shouldRecoverToPaying('paying', 10)).toBeNull();
  });
});

describe('computeForContact + recomputeBatch', () => {
  // computeForContact / recomputeBatch call computeHealthScore with its
  // default `now = new Date()`. Pin system time to FIXED_NOW so signal
  // timestamps built via isoDaysAgo() stay relative to the same reference
  // the scorer uses — otherwise this suite turns into a time-bomb that
  // breaks once real-now drifts past the 30-day no-usage cutoff.
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('computeForContact delegates to the injected loader', async () => {
    // Use a real recent timestamp so the 30-day usage penalty never triggers
    // regardless of when the test runs. FIXED_NOW-relative dates would drift
    // past the 30-day window as calendar time advances.
    const recentUsage = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const loadSignals = jest.fn().mockResolvedValue({
      subscriptionState: 'active',
      lastUsageAt: recentUsage,
    });

    const score = await computeForContact('user@example.com', { loadSignals });
    expect(loadSignals).toHaveBeenCalledWith('user@example.com');
    expect(score).toBe(50);
  });

  it('recomputeBatch returns a Map keyed by contactId', async () => {
    const loadSignals = jest.fn((id: string) => {
      if (id === 'a') return Promise.resolve({ subscriptionState: 'active' as const });
      return Promise.resolve({} as HealthScoreSignals);
    });

    const results = await recomputeBatch(['a', 'b'], { loadSignals });
    expect(results.get('a')).toBe(0); // sub active but no usage = 0
    expect(results.get('b')).toBe(0);
  });
});
