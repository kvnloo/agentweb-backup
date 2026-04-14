/**
 * Tests for heatScoreService (C1 — CRM Unification v1).
 *
 * 20+ test cases covering each rule independently, aggregation, clamp
 * behaviour, and the do-not-contact ceiling.
 */

import {
  computeHeatScore,
  computeForContact,
  recomputeBatch,
  HeatScoreSignals,
} from '../heatScoreService';

const FIXED_NOW = new Date('2026-04-14T12:00:00.000Z');

const baseline: HeatScoreSignals = {
  hasUserRecord: false,
  hasActiveSubscription: false,
  status: null,
  openDealStages: [],
  lastEngagementAt: null,
  isICP: false,
  contactStatus: 'active',
};

describe('computeHeatScore — individual rules', () => {
  it('returns 0 with no positive signals', () => {
    expect(computeHeatScore(baseline, FIXED_NOW)).toBe(0);
  });

  it('adds 25 when the contact has an AW-Users record', () => {
    expect(computeHeatScore({ ...baseline, hasUserRecord: true }, FIXED_NOW)).toBe(25);
  });

  it('adds 40 when the contact has an active subscription', () => {
    expect(computeHeatScore({ ...baseline, hasActiveSubscription: true }, FIXED_NOW)).toBe(40);
  });

  it('adds 20 when sales status is qualified', () => {
    expect(computeHeatScore({ ...baseline, status: 'qualified' }, FIXED_NOW)).toBe(20);
  });

  it('adds 20 when sales status is proposal_sent', () => {
    expect(computeHeatScore({ ...baseline, status: 'proposal_sent' }, FIXED_NOW)).toBe(20);
  });

  it('adds 20 when sales status is negotiating', () => {
    expect(computeHeatScore({ ...baseline, status: 'negotiating' }, FIXED_NOW)).toBe(20);
  });

  it('is case-insensitive on status', () => {
    expect(computeHeatScore({ ...baseline, status: 'QUALIFIED' }, FIXED_NOW)).toBe(20);
  });

  it('does NOT add 20 for unrelated statuses', () => {
    expect(computeHeatScore({ ...baseline, status: 'new' }, FIXED_NOW)).toBe(0);
    expect(computeHeatScore({ ...baseline, status: 'lost' }, FIXED_NOW)).toBe(0);
  });

  it('adds 20 when an open deal is at Qualified+', () => {
    expect(
      computeHeatScore({ ...baseline, openDealStages: ['Qualified'] }, FIXED_NOW)
    ).toBe(20);
    expect(
      computeHeatScore({ ...baseline, openDealStages: ['Demo'] }, FIXED_NOW)
    ).toBe(20);
    expect(
      computeHeatScore({ ...baseline, openDealStages: ['Proposal'] }, FIXED_NOW)
    ).toBe(20);
    expect(
      computeHeatScore({ ...baseline, openDealStages: ['Negotiation'] }, FIXED_NOW)
    ).toBe(20);
  });

  it('does NOT double-count when both status AND qualified deal exist', () => {
    expect(
      computeHeatScore(
        { ...baseline, status: 'qualified', openDealStages: ['Qualified'] },
        FIXED_NOW
      )
    ).toBe(20);
  });

  it('does NOT add 20 for Lead-stage deals', () => {
    expect(
      computeHeatScore({ ...baseline, openDealStages: ['Lead'] }, FIXED_NOW)
    ).toBe(0);
  });

  it('adds 15 for engagement within the last 7 days', () => {
    const threeDaysAgo = new Date(FIXED_NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(
      computeHeatScore({ ...baseline, lastEngagementAt: threeDaysAgo }, FIXED_NOW)
    ).toBe(15);
  });

  it('does NOT add 15 for engagement older than 7 days', () => {
    const tenDaysAgo = new Date(FIXED_NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
    expect(
      computeHeatScore({ ...baseline, lastEngagementAt: tenDaysAgo }, FIXED_NOW)
    ).toBe(0);
  });

  it('treats engagement dated in the future as inactive (clock skew guard)', () => {
    const future = new Date(FIXED_NOW.getTime() + 24 * 60 * 60 * 1000).toISOString();
    expect(
      computeHeatScore({ ...baseline, lastEngagementAt: future }, FIXED_NOW)
    ).toBe(0);
  });

  it('ignores malformed lastEngagementAt', () => {
    expect(
      computeHeatScore({ ...baseline, lastEngagementAt: 'not-a-date' }, FIXED_NOW)
    ).toBe(0);
  });

  it('adds 10 when isICP is true', () => {
    expect(computeHeatScore({ ...baseline, isICP: true }, FIXED_NOW)).toBe(10);
  });

  it('does not add 10 for isICP undefined or false', () => {
    expect(computeHeatScore({ ...baseline, isICP: false }, FIXED_NOW)).toBe(0);
    expect(computeHeatScore({ ...baseline, isICP: undefined }, FIXED_NOW)).toBe(0);
  });
});

describe('computeHeatScore — do-not-contact ceiling', () => {
  it('caps a do-not-contact lead below 50 even with every positive signal', () => {
    const signals: HeatScoreSignals = {
      hasUserRecord: true, // +25
      hasActiveSubscription: true, // +40
      status: 'qualified', // +20
      openDealStages: ['Negotiation'],
      lastEngagementAt: FIXED_NOW.toISOString(), // +15
      isICP: true, // +10
      contactStatus: 'do-not-contact', // -50
    };
    // 25+40+20+15+10 = 110, clamped to 100, -50 -> 50, but ceiling 49.
    const score = computeHeatScore(signals, FIXED_NOW);
    expect(score).toBeLessThan(50);
    expect(score).toBe(49);
  });

  it('caps unsubscribed leads below 50 too', () => {
    const signals: HeatScoreSignals = {
      hasUserRecord: true,
      hasActiveSubscription: true,
      contactStatus: 'unsubscribed',
    };
    expect(computeHeatScore(signals, FIXED_NOW)).toBeLessThan(50);
  });

  it('does not touch score for contactStatus = active', () => {
    const signals: HeatScoreSignals = {
      ...baseline,
      hasUserRecord: true,
      contactStatus: 'active',
    };
    expect(computeHeatScore(signals, FIXED_NOW)).toBe(25);
  });
});

describe('computeHeatScore — aggregation and clamping', () => {
  it('aggregates multiple positive signals', () => {
    const signals: HeatScoreSignals = {
      hasUserRecord: true, // +25
      hasActiveSubscription: true, // +40
      isICP: true, // +10
      contactStatus: 'active',
    };
    expect(computeHeatScore(signals, FIXED_NOW)).toBe(75);
  });

  it('clamps to 100 when every positive signal is on', () => {
    const signals: HeatScoreSignals = {
      hasUserRecord: true, // +25
      hasActiveSubscription: true, // +40
      status: 'qualified', // +20
      lastEngagementAt: FIXED_NOW.toISOString(), // +15
      isICP: true, // +10
      contactStatus: 'active',
    };
    // 25+40+20+15+10 = 110 -> clamped to 100
    expect(computeHeatScore(signals, FIXED_NOW)).toBe(100);
  });

  it('never returns a negative score', () => {
    const signals: HeatScoreSignals = {
      contactStatus: 'do-not-contact',
    };
    expect(computeHeatScore(signals, FIXED_NOW)).toBeGreaterThanOrEqual(0);
  });
});

describe('computeForContact', () => {
  it('delegates loading to the injected fetcher and returns the score', async () => {
    const loadSignals = jest.fn().mockResolvedValue({
      hasUserRecord: true,
      contactStatus: 'active',
    });

    const score = await computeForContact('jane@acme.com', { loadSignals });
    expect(loadSignals).toHaveBeenCalledWith('jane@acme.com');
    expect(score).toBe(25);
  });
});

describe('recomputeBatch', () => {
  it('returns a Map of contactId -> score', async () => {
    const loadSignals = jest.fn((id: string) => {
      if (id === 'a@x.com') return Promise.resolve({ hasUserRecord: true });
      return Promise.resolve({} as HeatScoreSignals);
    });

    const results = await recomputeBatch(['a@x.com', 'b@x.com'], { loadSignals });
    expect(results.get('a@x.com')).toBe(25);
    expect(results.get('b@x.com')).toBe(0);
  });
});
