/**
 * Tests for the ENG-1250 §3 monthly projection (derived form).
 *
 * The load-bearing claims are: spend and allowance never contaminate each
 * other, reservations are not spend, the invariant actually detects loss, and
 * the module cannot reintroduce the `optimized` boundary ENG-1211 removed.
 */
import {
  PROJECTION_TOLERANCE_MICRO_USD,
  projectMonth,
  reconcileProjection,
} from '../services/spendProjection';
import { SpendEvent } from '../services/spendEventDb';
import { LlmUsagePolicy } from '../services/llmUsagePolicyService';

const anEvent = (over: Partial<SpendEvent> = {}): SpendEvent => ({
  billingUserId: 'owner-1',
  eventId: 'e1',
  occurredAt: '2026-09-07T10:00:00.000Z',
  billingMonth: '2026-09',
  actingUserId: 'user-1',
  provider: 'you.com',
  operation: 'query',
  unit: 'query',
  quantity: 1,
  costMicroUsd: 12500,
  costSource: 'allocated',
  rateCardVersion: '2026-09-02',
  lifecycle: 'settled',
  ...over,
});

const allowance = { includedAllowanceMicroUsd: 3_000_000 }; // $3

const enforcingPolicy: LlmUsagePolicy = {
  version: 'test',
  enforcementState: 'enforce',
  optimizationCostThresholdMicroUsd: 1_000_000,
  hardCostThresholdMicroUsd: 5_000_000,
  optimizedModelIds: ['m1'],
  optimizedDefaultModel: 'm1',
};

describe('projectMonth', () => {
  it('sums settled spend and counts reservations separately', () => {
    const p = projectMonth('owner-1', '2026-09', [
      anEvent({ eventId: 'a', costMicroUsd: 100 }),
      anEvent({ eventId: 'b', costMicroUsd: 23 }),
      anEvent({ eventId: 'c', costMicroUsd: 5000, lifecycle: 'reserved' }),
      anEvent({ eventId: 'd', costMicroUsd: 0, lifecycle: 'voided' }),
    ], allowance);

    expect(p.settledMicroUsd).toBe(123);
    expect(p.reservedMicroUsd).toBe(5000);
    expect(p.settledEventCount).toBe(2);
    expect(p.reservedEventCount).toBe(1);
    expect(p.voidedEventCount).toBe(1);
  });

  it('excludes another subject\'s and another month\'s events, and says how many', () => {
    const p = projectMonth('owner-1', '2026-09', [
      anEvent({ eventId: 'mine', costMicroUsd: 100 }),
      anEvent({ eventId: 'theirs', billingUserId: 'owner-2', costMicroUsd: 999999 }),
      anEvent({ eventId: 'lastmonth', billingMonth: '2026-08', costMicroUsd: 888888 }),
    ], allowance);

    expect(p.settledMicroUsd).toBe(100);
    expect(p.excludedEventCount).toBe(2);
  });

  describe('spend and allowance never contaminate each other (§3)', () => {
    it('credits raise the allowance and leave spend untouched', () => {
      const events = [anEvent({ costMicroUsd: 1_000_000 })];

      const without = projectMonth('owner-1', '2026-09', events, allowance);
      const with_ = projectMonth('owner-1', '2026-09', events, {
        ...allowance,
        purchasedCreditsMicroUsd: 2_000_000,
      });

      expect(with_.settledMicroUsd).toBe(without.settledMicroUsd);
      expect(with_.usableAllowanceMicroUsd).toBe(5_000_000);
      expect(with_.remainingMicroUsd).toBe(4_000_000);
    });

    it('an admin reversal reduces the allowance, never the recorded spend', () => {
      const p = projectMonth('owner-1', '2026-09', [anEvent({ costMicroUsd: 500_000 })], {
        ...allowance,
        adminAdjustmentMicroUsd: -1_000_000,
      });

      expect(p.settledMicroUsd).toBe(500_000);
      expect(p.usableAllowanceMicroUsd).toBe(2_000_000);
    });

    it('adjustments cannot drive the allowance negative into phantom spend', () => {
      const p = projectMonth('owner-1', '2026-09', [], {
        includedAllowanceMicroUsd: 1_000_000,
        adminAdjustmentMicroUsd: -9_000_000,
      });

      expect(p.usableAllowanceMicroUsd).toBe(0);
      expect(p.remainingMicroUsd).toBe(0);
      expect(p.overspentMicroUsd).toBe(0);
    });
  });

  describe('remaining balance', () => {
    it('counts reservations against what is left', () => {
      const p = projectMonth('owner-1', '2026-09', [
        anEvent({ eventId: 'a', costMicroUsd: 1_000_000 }),
        anEvent({ eventId: 'b', costMicroUsd: 500_000, lifecycle: 'reserved' }),
      ], allowance);

      expect(p.remainingMicroUsd).toBe(1_500_000);
    });

    it('reports overspend rather than a negative remaining balance', () => {
      const p = projectMonth('owner-1', '2026-09', [anEvent({ costMicroUsd: 4_000_000 })], allowance);

      expect(p.remainingMicroUsd).toBe(0);
      expect(p.overspentMicroUsd).toBe(1_000_000);
    });
  });

  describe('policy mode is delegated, never reimplemented', () => {
    it('never returns "optimized" — ENG-1211 removed that boundary', () => {
      // Spend deliberately placed between the optimization threshold ($1) and
      // the hard cap ($5), which is where the old middle mode used to sit.
      const p = projectMonth('owner-1', '2026-09', [anEvent({ costMicroUsd: 3_000_000 })], allowance, enforcingPolicy);

      expect(p.policyMode).toBe('full_choice');
    });

    it('pauses at the hard cap, the one remaining boundary', () => {
      const p = projectMonth('owner-1', '2026-09', [anEvent({ costMicroUsd: 5_000_000 })], allowance, enforcingPolicy);

      expect(p.policyMode).toBe('paused');
    });

    // CodeRabbit, PR #2791: this module declares exactly ONE intended
    // divergence from the live gate (all-vendor spend, not LLM-only). Counting
    // reservations too would add a second, undocumented one, and §8 could no
    // longer attribute a difference to either.
    it('measures settled spend only, so the one intended divergence stays the only one', () => {
      const p = projectMonth('owner-1', '2026-09', [
        anEvent({ eventId: 'a', costMicroUsd: 4_000_000 }),
        anEvent({ eventId: 'b', costMicroUsd: 1_000_000, lifecycle: 'reserved' }),
      ], allowance, enforcingPolicy);

      // 4m settled is below the 5m hard cap; the reservation must not push it over.
      expect(p.policyMode).toBe('full_choice');
      // §4's admission basis is settled + reserved — exposed as separate fields
      // for whoever builds it, not folded into this measurement.
      expect(p.settledMicroUsd + p.reservedMicroUsd).toBe(5_000_000);
    });

    it('a malformed policy cannot take the whole projection down with it', () => {
      // optimizedDefaultModel absent from optimizedModelIds fails validation,
      // and evaluateLlmUsageMode throws on it for an enforcing policy.
      const broken = { ...enforcingPolicy, optimizedModelIds: ['a'], optimizedDefaultModel: 'b' };

      const p = projectMonth('owner-1', '2026-09', [anEvent({ costMicroUsd: 123 })], allowance, broken);

      // The figures that matter survive.
      expect(p.settledMicroUsd).toBe(123);
      // And the failure is reported, not swallowed.
      expect(p.policyMode).toBe('full_choice');
      expect(p.policyModeError).toMatch(/optimizedDefaultModel/);
    });

    it('reports no policy error on the normal path', () => {
      expect(projectMonth('owner-1', '2026-09', [anEvent()], allowance, enforcingPolicy).policyModeError)
        .toBeUndefined();
    });

    it('is full_choice with no policy — an unconfigured tier is not a paused one', () => {
      expect(projectMonth('owner-1', '2026-09', [anEvent({ costMicroUsd: 9_000_000 })], allowance).policyMode)
        .toBe('full_choice');
    });
  });
});

  describe('unlimited tiers', () => {
    it('never reports overspend for an account with no cap', () => {
      // Without this an uncapped account arrives with a 0 allowance -- "no
      // policy" is not "zero dollars" -- and every micro-dollar it spends
      // reads as overspend, so the response would call the account unlimited
      // AND say it blew through a zero cap (CodeRabbit, PR #2811).
      const p = projectMonth('owner-1', '2026-09', [anEvent({ costMicroUsd: 9_000_000 })], {
        includedAllowanceMicroUsd: 0,
        unlimited: true,
      });

      expect(p.unlimited).toBe(true);
      expect(p.overspentMicroUsd).toBe(0);
      expect(p.remainingMicroUsd).toBe(0);
      expect(p.settledMicroUsd).toBe(9_000_000);
    });

    it('still reports overspend for a capped account', () => {
      const p = projectMonth('owner-1', '2026-09', [anEvent({ costMicroUsd: 9_000_000 })], allowance);

      expect(p.unlimited).toBe(false);
      expect(p.overspentMicroUsd).toBe(6_000_000);
    });
  });

describe('reconcileProjection — §3 invariant', () => {
  it('agrees with a projection built from the same events', () => {
    const events = [
      anEvent({ eventId: 'a', costMicroUsd: 100 }),
      anEvent({ eventId: 'b', costMicroUsd: 23 }),
      anEvent({ eventId: 'c', costMicroUsd: 5000, lifecycle: 'reserved' }),
    ];

    const result = reconcileProjection(events, projectMonth('owner-1', '2026-09', events, allowance));

    expect(result).toMatchObject({ ok: true, driftMicroUsd: 0 });
  });

  it('detects a single lost event', () => {
    const events = [anEvent({ eventId: 'a', costMicroUsd: 100 }), anEvent({ eventId: 'b', costMicroUsd: 23 })];
    const projection = projectMonth('owner-1', '2026-09', [events[0]], allowance);

    const result = reconcileProjection(events, projection);

    expect(result.ok).toBe(false);
    expect(result.driftMicroUsd).toBe(23);
  });

  it('detects a double count as negative drift', () => {
    const events = [anEvent({ eventId: 'a', costMicroUsd: 100 })];
    const projection = projectMonth('owner-1', '2026-09', [anEvent({ eventId: 'a' }), anEvent({ eventId: 'b' })], allowance);

    expect(reconcileProjection(events, projection).driftMicroUsd).toBeLessThan(0);
  });

  it('catches a drift of exactly one micro-dollar over tolerance', () => {
    const projection = projectMonth('owner-1', '2026-09', [anEvent({ costMicroUsd: 100 })], allowance);
    const drifted = [anEvent({ costMicroUsd: 100 + PROJECTION_TOLERANCE_MICRO_USD + 1 })];

    expect(reconcileProjection(drifted, projection).ok).toBe(false);
  });

  it('an event written to the wrong month reads as drift, not as a silent loss', () => {
    const events = [anEvent({ eventId: 'a', costMicroUsd: 100 }), anEvent({ eventId: 'b', costMicroUsd: 50, billingMonth: '2026-10' })];
    const projection = projectMonth('owner-1', '2026-09', events, allowance);

    // The projection excluded it, and reconciliation over the same set agrees —
    // the tell is excludedEventCount, which is why that field exists.
    expect(reconcileProjection(events, projection).ok).toBe(true);
    expect(projection.excludedEventCount).toBe(1);
  });

  it('is exact over many small amounts', () => {
    const events = Array.from({ length: 10000 }, (_, i) => anEvent({ eventId: `e${i}`, costMicroUsd: 1 }));

    const result = reconcileProjection(events, projectMonth('owner-1', '2026-09', events, allowance));

    expect(result.driftMicroUsd).toBe(0);
    expect(result.eventSumMicroUsd).toBe(10000);
  });
});
