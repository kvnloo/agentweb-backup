/**
 * ENG-1250 §7 read models.
 *
 * The requirement being tested is a usability one with a correctness core:
 * "no admin should need direct DynamoDB inspection to explain a pause". So the
 * claims that matter are that the slices account for every event (a gap reads
 * as missing spend, not missing metadata), that reservations never get counted
 * as spend, and that the pause explanation cannot contradict the decision it
 * explains.
 */
import { buildSpendBreakdown, explainPause, resolveAllowanceInputs } from '../services/spendReadModel';
import { SpendEvent } from '../services/spendEventDb';
import { MonthlyProjection } from '../services/spendProjection';

const anEvent = (over: Partial<SpendEvent> = {}): SpendEvent => ({
  billingUserId: 'owner-1',
  eventId: 'e1',
  occurredAt: '2026-09-08T10:00:00.000Z',
  billingMonth: '2026-09',
  actingUserId: 'member-1',
  provider: 'you.com',
  operation: 'query',
  feature: 'agent-search',
  unit: 'query',
  quantity: 1,
  costMicroUsd: 12500,
  costSource: 'allocated',
  rateCardVersion: '2026-09-02',
  lifecycle: 'settled',
  ...over,
});

const aProjection = (over: Partial<MonthlyProjection> = {}): MonthlyProjection => ({
  billingUserId: 'owner-1',
  billingMonth: '2026-09',
  settledMicroUsd: 0,
  reservedMicroUsd: 0,
  includedAllowanceMicroUsd: 0,
  purchasedCreditsMicroUsd: 0,
  adminAdjustmentMicroUsd: 0,
  migrationAdjustmentMicroUsd: 0,
  usableAllowanceMicroUsd: 0,
  remainingMicroUsd: 0,
  overspentMicroUsd: 0,
  policyMode: 'full_choice',
  settledEventCount: 0,
  reservedEventCount: 0,
  voidedEventCount: 0,
  excludedEventCount: 0,
  ...over,
});

describe('buildSpendBreakdown', () => {
  it('scopes to the subject and month rather than trusting the caller', () => {
    const b = buildSpendBreakdown('owner-1', '2026-09', [
      anEvent({ eventId: 'mine' }),
      anEvent({ eventId: 'theirs', billingUserId: 'owner-2', costMicroUsd: 999_999 }),
      anEvent({ eventId: 'august', billingMonth: '2026-08', costMicroUsd: 888_888 }),
    ]);

    expect(b.settledMicroUsd).toBe(12500);
    expect(b.eventCount).toBe(1);
  });

  it('never counts a reservation as spend', () => {
    const b = buildSpendBreakdown('owner-1', '2026-09', [
      anEvent({ eventId: 'a', costMicroUsd: 100 }),
      anEvent({ eventId: 'b', costMicroUsd: 5000, lifecycle: 'reserved' }),
      anEvent({ eventId: 'c', costMicroUsd: 0, lifecycle: 'voided' }),
    ]);

    expect(b.settledMicroUsd).toBe(100);
    expect(b.inFlightMicroUsd).toBe(5000);
    expect(b.byProvider[0]).toMatchObject({ settledMicroUsd: 100, reservedMicroUsd: 5000 });
  });

  describe('slices', () => {
    const events = [
      anEvent({ eventId: '1', provider: 'v0', feature: 'landing_page', actingUserId: 'm1', costMicroUsd: 2_000_000 }),
      anEvent({ eventId: '2', provider: 'you.com', feature: 'agent-search', actingUserId: 'm2', costMicroUsd: 12_500 }),
      anEvent({ eventId: '3', provider: 'you.com', feature: 'agent-search', actingUserId: 'm1', costMicroUsd: 12_500 }),
    ];

    it('orders by settled spend so the cause of a pause is at the top', () => {
      // Deliberately chosen so spend order CONTRADICTS alphabetical order —
      // with 'v0'/'you.com' the two coincide, and the assertion would pass
      // against a sort that ignores spend entirely.
      const b = buildSpendBreakdown('owner-1', '2026-09', [
        anEvent({ eventId: '1', provider: 'apollo', costMicroUsd: 1_000 }),
        anEvent({ eventId: '2', provider: 'v0', costMicroUsd: 2_000_000 }),
      ]);

      expect(b.byProvider.map((s) => s.key)).toEqual(['v0', 'apollo']);
      expect(b.byProvider[0].settledMicroUsd).toBe(2_000_000);
    });

    it('falls back to a stable key order when spend ties', () => {
      const b = buildSpendBreakdown('owner-1', '2026-09', [
        anEvent({ eventId: '1', provider: 'zeta', costMicroUsd: 100 }),
        anEvent({ eventId: '2', provider: 'alpha', costMicroUsd: 100 }),
      ]);

      expect(b.byProvider.map((s) => s.key)).toEqual(['alpha', 'zeta']);
    });

    it('slices by the ACTING member, not the payer', () => {
      // Every event here shares one payer, so slicing by that would give one
      // bucket. "Who spent this" is the question §7 asks.
      const b = buildSpendBreakdown('owner-1', '2026-09', events);

      expect(b.byMember.map((s) => s.key).sort()).toEqual(['m1', 'm2']);
      expect(b.byMember.find((s) => s.key === 'm1')!.settledMicroUsd).toBe(2_012_500);
    });

    it('every slice accounts for every event — a gap would read as missing spend', () => {
      const b = buildSpendBreakdown('owner-1', '2026-09', events);

      for (const dimension of [b.byProvider, b.byFeature, b.byMember, b.bySession]) {
        expect(dimension.reduce((t, s) => t + s.settledMicroUsd, 0)).toBe(b.settledMicroUsd);
        expect(dimension.reduce((t, s) => t + s.eventCount, 0)).toBe(b.eventCount);
      }
    });

    it('buckets a missing dimension explicitly rather than dropping the event', () => {
      const b = buildSpendBreakdown('owner-1', '2026-09', [anEvent({ feature: undefined })]);

      expect(b.byFeature).toHaveLength(1);
      expect(b.byFeature[0].key).toBe('(unattributed)');
      expect(b.byFeature[0].settledMicroUsd).toBe(12500);
    });

    it('reports percentages that sum to 100 when anything is settled', () => {
      const b = buildSpendBreakdown('owner-1', '2026-09', events);

      expect(b.byProvider.reduce((t, s) => t + s.percentOfSettled, 0)).toBeCloseTo(100, 6);
    });

    it('reports 0% rather than NaN when nothing is settled', () => {
      const b = buildSpendBreakdown('owner-1', '2026-09', [anEvent({ lifecycle: 'reserved' })]);

      expect(b.byProvider[0].percentOfSettled).toBe(0);
    });
  });

  describe('daily trend', () => {
    it('is oldest first and lists only days with events', () => {
      const b = buildSpendBreakdown('owner-1', '2026-09', [
        anEvent({ eventId: 'b', occurredAt: '2026-09-09T10:00:00.000Z' }),
        anEvent({ eventId: 'a', occurredAt: '2026-09-08T10:00:00.000Z' }),
      ]);

      expect(b.daily.map((d) => d.date)).toEqual(['2026-09-08', '2026-09-09']);
    });
  });

  describe('in-flight reservations', () => {
    it('lists open reservations newest first', () => {
      const b = buildSpendBreakdown('owner-1', '2026-09', [
        anEvent({ eventId: 'old', lifecycle: 'reserved', occurredAt: '2026-09-08T09:00:00.000Z' }),
        anEvent({ eventId: 'new', lifecycle: 'reserved', occurredAt: '2026-09-08T11:00:00.000Z' }),
        anEvent({ eventId: 'settled' }),
      ]);

      expect(b.inFlight.map((r) => r.eventId)).toEqual(['new', 'old']);
    });
  });
});

describe('explainPause', () => {
  const breakdown = buildSpendBreakdown('owner-1', '2026-09', [
    anEvent({ eventId: '1', provider: 'v0', costMicroUsd: 4_000_000 }),
    anEvent({ eventId: '2', provider: 'you.com', costMicroUsd: 1_000_000 }),
  ]);

  it('says nothing when the account is not paused', () => {
    const e = explainPause(aProjection({ policyMode: 'full_choice' }), breakdown);

    expect(e.paused).toBe(false);
    expect(e.reason).toBeNull();
    expect(e.topProviders).toEqual([]);
  });

  it('explains a pause in dollars, naming what drove it', () => {
    const e = explainPause(
      aProjection({
        policyMode: 'paused',
        settledMicroUsd: 5_000_000,
        usableAllowanceMicroUsd: 5_000_000,
      }),
      breakdown,
    );

    expect(e.paused).toBe(true);
    expect(e.reason).toContain('$5.00');
    expect(e.reason).toContain('v0');
    expect(e.topProviders[0].key).toBe('v0');
  });

  it('calls out in-flight spend, which a settled-only view would hide', () => {
    const e = explainPause(
      aProjection({ policyMode: 'paused', settledMicroUsd: 4_000_000, reservedMicroUsd: 1_000_000 }),
      breakdown,
    );

    expect(e.reason).toContain('in-flight');
    expect(e.reason).toContain('$1.00');
  });

  it('reads the projection\'s mode rather than recomputing it', () => {
    // An explanation that contradicts the decision it explains is worse than
    // none, so this must follow the projection even when the numbers alone
    // would suggest otherwise.
    const e = explainPause(
      aProjection({ policyMode: 'full_choice', settledMicroUsd: 99_000_000, usableAllowanceMicroUsd: 1 }),
      breakdown,
    );

    expect(e.paused).toBe(false);
  });
});

describe('resolveAllowanceInputs', () => {
  const adjustment = { purchasedMicroUsd: 2_000_000, adminGrantedMicroUsd: 500_000, migrationOffsetMicroUsd: 300_000 };
  const deps = (over: Partial<Parameters<typeof resolveAllowanceInputs>[2]> = {}) => ({
    getUser: async () => ({ subscriptionType: 'Pro', llmUsageCredits: {} }),
    getTierConfig: async () => ({ llmUsagePolicy: { hardCostThresholdMicroUsd: 200_000_000 } }),
    getCreditAdjustment: () => adjustment,
    ...over,
  });

  it('reads every input from the same places the live gate reads them', async () => {
    const a = await resolveAllowanceInputs('owner-1', '2026-09', deps());

    expect(a).toEqual({
      includedAllowanceMicroUsd: 200_000_000,
      purchasedCreditsMicroUsd: 2_000_000,
      adminAdjustmentMicroUsd: 500_000,
      migrationAdjustmentMicroUsd: 300_000,
      unlimited: false,
    });
  });

  it('ADDS the migration offset rather than subtracting it', async () => {
    // The unit-economics report applies the same adjustment by reducing SPEND;
    // the projection applies it by raising the ALLOWANCE. Same inequality,
    // opposite sides — flipping the sign here would silently double the error.
    const a = await resolveAllowanceInputs('owner-1', '2026-09', deps());

    expect(a.migrationAdjustmentMicroUsd).toBe(+300_000);
  });

  it('marks a tier with no policy as unlimited, not as zero allowance', async () => {
    // Defaulting to 0 would report every uncapped account as massively
    // overspent and paused — the opposite of the truth.
    const a = await resolveAllowanceInputs('owner-1', '2026-09', deps({ getTierConfig: async () => ({}) } as any));

    expect(a.unlimited).toBe(true);
  });

  it('handles a user with no subscription type without calling the tier lookup', async () => {
    const getTierConfig = jest.fn();
    const a = await resolveAllowanceInputs('owner-1', '2026-09', deps({
      getUser: async () => ({}),
      getTierConfig,
    } as any));

    expect(getTierConfig).not.toHaveBeenCalled();
    expect(a.unlimited).toBe(true);
  });

  it('passes the requested month through to the credit ledger', async () => {
    const getCreditAdjustment = jest.fn().mockReturnValue(adjustment);
    await resolveAllowanceInputs('owner-1', '2026-07', deps({ getCreditAdjustment } as any));

    expect(getCreditAdjustment).toHaveBeenCalledWith(expect.anything(), '2026-07');
  });
});
