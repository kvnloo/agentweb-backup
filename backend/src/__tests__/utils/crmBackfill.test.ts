import {
  BackfillLead,
  BackfillUser,
  computeBackfillScores,
  isLeadAlreadyBackfilled,
  mapSubscriptionState,
  pickLatestTimestamp,
} from '../../utils/crmBackfill';

const NOW = new Date('2026-04-18T12:00:00Z');

function makeLead(overrides: Partial<BackfillLead> = {}): BackfillLead {
  return {
    listId: 'list_1',
    leadId: 'lead_1',
    email: 'prospect@acme.io',
    ...overrides,
  };
}

function makeUser(overrides: Partial<BackfillUser> = {}): BackfillUser {
  return {
    userId: 'u_1',
    email: 'prospect@acme.io',
    ...overrides,
  };
}

describe('crmBackfill utils', () => {
  describe('mapSubscriptionState', () => {
    it('maps active/trialing/past_due/canceled verbatim', () => {
      expect(mapSubscriptionState('active')).toBe('active');
      expect(mapSubscriptionState('trialing')).toBe('trialing');
      expect(mapSubscriptionState('past_due')).toBe('past_due');
      expect(mapSubscriptionState('canceled')).toBe('canceled');
    });

    it('maps legacy aliases', () => {
      expect(mapSubscriptionState('unpaid')).toBe('past_due');
      expect(mapSubscriptionState('cancelled')).toBe('canceled');
      expect(mapSubscriptionState('incomplete_expired')).toBe('canceled');
    });

    it('returns "none" for null/undefined/empty/unknown', () => {
      expect(mapSubscriptionState(null)).toBe('none');
      expect(mapSubscriptionState(undefined)).toBe('none');
      expect(mapSubscriptionState('')).toBe('none');
      expect(mapSubscriptionState('incomplete')).toBe('none');
      expect(mapSubscriptionState('foobar')).toBe('none');
    });

    it('is case-insensitive and trims whitespace', () => {
      expect(mapSubscriptionState('ACTIVE')).toBe('active');
      expect(mapSubscriptionState('  Trialing  ')).toBe('trialing');
    });
  });

  describe('pickLatestTimestamp', () => {
    it('returns null when all candidates are empty', () => {
      expect(pickLatestTimestamp(null, undefined, '')).toBeNull();
    });

    it('returns the single valid value when others are null', () => {
      expect(pickLatestTimestamp(null, '2026-04-01T00:00:00Z', undefined)).toBe(
        '2026-04-01T00:00:00Z'
      );
    });

    it('returns the newest timestamp when multiple are valid', () => {
      const out = pickLatestTimestamp(
        '2026-04-01T00:00:00Z',
        '2026-04-17T00:00:00Z',
        '2026-03-15T00:00:00Z'
      );
      expect(out).toBe('2026-04-17T00:00:00Z');
    });

    it('ignores malformed strings', () => {
      const out = pickLatestTimestamp('not-a-date', '2026-04-01T00:00:00Z', 'junk');
      expect(out).toBe('2026-04-01T00:00:00Z');
    });
  });

  describe('isLeadAlreadyBackfilled', () => {
    it('returns true when all three scores are set', () => {
      const lead = makeLead({ lifecycle: 'inbox', heatScore: 0, healthScore: 0 });
      expect(isLeadAlreadyBackfilled(lead)).toBe(true);
    });

    it('treats 0 as a valid score (not "missing")', () => {
      const lead = makeLead({ lifecycle: 'inbox', heatScore: 0, healthScore: 0 });
      expect(isLeadAlreadyBackfilled(lead)).toBe(true);
    });

    it('returns false when lifecycle is missing', () => {
      const lead = makeLead({ lifecycle: null, heatScore: 10, healthScore: 10 });
      expect(isLeadAlreadyBackfilled(lead)).toBe(false);
    });

    it('returns false when heatScore is missing', () => {
      const lead = makeLead({ lifecycle: 'inbox', heatScore: null, healthScore: 10 });
      expect(isLeadAlreadyBackfilled(lead)).toBe(false);
    });

    it('returns false when healthScore is missing', () => {
      const lead = makeLead({ lifecycle: 'inbox', heatScore: 10, healthScore: null });
      expect(isLeadAlreadyBackfilled(lead)).toBe(false);
    });

    it('returns false when all scores are null (fresh lead)', () => {
      expect(isLeadAlreadyBackfilled(makeLead())).toBe(false);
    });
  });

  describe('computeBackfillScores', () => {
    it('classifies an email-only lead with no user as inbox + low heat', () => {
      const out = computeBackfillScores(
        { lead: makeLead(), user: null },
        NOW
      );
      expect(out.lifecycle).toBe('inbox');
      expect(out.heatScore).toBe(0); // no user, no sub, no status, no engagement, no ICP
      expect(out.healthScore).toBe(0); // no sub, no usage
    });

    it('classifies a user with an active Stripe subscription as paying + high heat + high health', () => {
      const out = computeBackfillScores(
        {
          lead: makeLead(),
          user: makeUser({
            stripe_customer_id: 'cus_123',
            subscription_status: 'active',
          }),
          lastUsageAt: '2026-04-17T00:00:00Z', // yesterday, within 30d
          lastEmmaSessionAt: '2026-04-17T00:00:00Z', // within 7d → +25
        },
        NOW
      );
      expect(out.lifecycle).toBe('paying');
      // heat: +25 user +40 active sub = 65
      expect(out.heatScore).toBe(65);
      // health: +50 active +25 recent Emma = 75
      expect(out.healthScore).toBe(75);
    });

    it('classifies a signed-up user without a sub as signed_up', () => {
      const out = computeBackfillScores(
        {
          lead: makeLead(),
          user: makeUser({ subscription_status: null }),
        },
        NOW
      );
      expect(out.lifecycle).toBe('signed_up');
      expect(out.heatScore).toBe(25); // +25 has user record
      expect(out.healthScore).toBe(0);
    });

    it('drops heat to the opted-out ceiling for do-not-contact leads', () => {
      const out = computeBackfillScores(
        {
          lead: makeLead({ contactStatus: 'do-not-contact' }),
          user: makeUser({ subscription_status: 'active' }),
        },
        NOW
      );
      // Positive signals would total +65, but opted-out ceiling clamps <50.
      expect(out.heatScore).toBeLessThanOrEqual(49);
      // Lifecycle still tracks the truth: they are paying.
      expect(out.lifecycle).toBe('paying');
    });

    it('classifies a churned lead (subscription canceled)', () => {
      const out = computeBackfillScores(
        {
          lead: makeLead({ lifecycle: 'paying' }),
          user: makeUser({ subscription_status: 'canceled' }),
        },
        NOW
      );
      expect(out.lifecycle).toBe('churned');
    });

    it('flags a paying lead with no recent usage as at_risk', () => {
      // lastUsageAt 45 days ago while user is still active
      const oldUsage = new Date(NOW.getTime() - 45 * 24 * 60 * 60 * 1000).toISOString();
      const out = computeBackfillScores(
        {
          lead: makeLead({ lifecycle: 'paying' }),
          user: makeUser({ subscription_status: 'active' }),
          lastUsageAt: oldUsage,
          lastEngagementAt: oldUsage, // activity within 60d so not churned
        },
        NOW
      );
      expect(out.lifecycle).toBe('at_risk');
      // Health: +50 active -50 no usage >30d = 0
      expect(out.healthScore).toBe(0);
    });

    it('maps isICP as numeric 1 correctly', () => {
      const out = computeBackfillScores(
        { lead: makeLead({ isICP: 1 }), user: null },
        NOW
      );
      expect(out.heatScore).toBeGreaterThanOrEqual(10); // +10 ICP
    });

    it('maps isICP as numeric 0 as false', () => {
      const out = computeBackfillScores(
        { lead: makeLead({ isICP: 0 }), user: null },
        NOW
      );
      expect(out.heatScore).toBe(0);
    });

    it('respects in_deal lifecycle when deal stages include an open stage', () => {
      // Per lifecycleService spec (rule 5 in_deal beats rule 6 signed_up):
      // if a lead has an open deal, it's in_deal even when a user record exists —
      // only a subscription bumps them up to trialing/paying.
      const out = computeBackfillScores(
        {
          lead: makeLead(),
          user: makeUser({ subscription_status: null }),
          openDealStages: ['Qualified'],
        },
        NOW
      );
      expect(out.lifecycle).toBe('in_deal');

      const out2 = computeBackfillScores(
        {
          lead: makeLead(),
          user: null,
          openDealStages: ['Qualified'],
        },
        NOW
      );
      expect(out2.lifecycle).toBe('in_deal');

      // Closed deals (Won/Lost) do NOT keep the lead in_deal.
      const out3 = computeBackfillScores(
        {
          lead: makeLead(),
          user: makeUser({ subscription_status: null }),
          openDealStages: ['Won'],
        },
        NOW
      );
      expect(out3.lifecycle).toBe('signed_up');
    });

    it('returns "unknown" for a lead with no email and no user', () => {
      const out = computeBackfillScores(
        { lead: makeLead({ email: null }), user: null },
        NOW
      );
      expect(out.lifecycle).toBe('unknown');
    });

    it('forwards optional string signals rather than coercing to null', () => {
      // Covers the ?? null branches on lead.status, lastEmmaSessionAt,
      // lastEngagementReplyAt, and unresolvedSupportIssueOpenedAt — heat +20
      // for an active-sales status, health -40 for an unresolved issue >7d old.
      const oldIssue = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const out = computeBackfillScores(
        {
          lead: makeLead({ status: 'qualified' }),
          user: makeUser({ subscription_status: 'active' }),
          lastEngagementReplyAt: '2026-04-17T00:00:00Z', // within 14d → +15
          unresolvedSupportIssueOpenedAt: oldIssue,
        },
        NOW
      );
      // heat: +25 user +40 active +20 qualified = 85
      expect(out.heatScore).toBe(85);
      // health: +50 active +15 reply -40 unresolved issue -50 no usage>30d = -25 → clamp 0
      expect(out.healthScore).toBe(0);
    });
  });
});
