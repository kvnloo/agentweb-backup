/**
 * ENG-2143: account-health classifier. Fixtures cover ENG-2016 AC1/AC2/AC5/AC7 (classification
 * side), ENG-1913 AC1-5 (zero delivery) and ENG-2133's rule that a never-connected account is an
 * activation state, never at-risk.
 */
import {
  classifyAccountHealth,
  classifyAdConnections,
  evaluateZeroDelivery,
  resolveCurrentRequirement,
  billingCycleKey,
  buildAdDays,
  evaluateAdTrend,
  evaluateFeedback,
  type AccountHealthSignals,
  type AdDayInput,
  type CampaignDeliveryInput,
} from '../services/accountHealthClassifier';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const expiredMeta = { platform: 'meta', config: { account_type: 'ad_account', token_expires_at: NOW - 3 * DAY_MS } };
const liveMeta = { platform: 'meta', config: { account_type: 'ad_account', token_expires_at: NOW + 30 * DAY_MS } };

function signals(overrides: Partial<AccountHealthSignals> = {}): AccountHealthSignals {
  return {
    nowMs: NOW,
    connectedAccounts: [liveMeta],
    requirement: null,
    subscriptionStatus: 'active',
    currentPeriodEnd: '2026-10-10T00:00:00.000Z',
    payments: [{ eventType: 'payment_succeeded', timestamp: ago(10 * DAY_MS) }],
    campaigns: [],
    recentAdSpend: 0,
    lastActiveAt: ago(2 * DAY_MS),
    ...overrides,
  };
}

const codes = (s: AccountHealthSignals) => classifyAccountHealth(s).evidence.map((e) => e.code);

describe('classifyAdConnections', () => {
  it('reads Meta through classifyMetaAdConnection and Google Ads / LinkedIn Ads with the same token rule', () => {
    expect(classifyAdConnections([], undefined, NOW).state).toBe('never_connected');
    expect(classifyAdConnections(null, 'act_123', NOW).state).toBe('connected');
    expect(classifyAdConnections([expiredMeta], undefined, NOW)).toMatchObject({ state: 'expired', meta: 'expired' });
    // Google Ads tokens carry a refresh token, so an old access-token expiry is still usable.
    expect(
      classifyAdConnections([expiredMeta, { platform: 'google_ads', config: { token_expires_at: NOW - DAY_MS, refresh_token: 'r' } }], undefined, NOW),
    ).toMatchObject({ state: 'connected', others: { google_ads: 'connected' } });
    const linkedInExpired = classifyAdConnections(
      [{ platform: 'linkedin_ads', config: { token_expires_at: NOW - DAY_MS } }],
      undefined,
      NOW,
    );
    expect(linkedInExpired).toMatchObject({ state: 'expired', meta: 'other_platform', others: { linkedin_ads: 'expired' } });
    expect(linkedInExpired.expiredAt).toBe(ago(DAY_MS));
    // Non-ad platforms never count as an ad connection.
    expect(classifyAdConnections([{ platform: 'linkedin', config: {} }], undefined, NOW).state).toBe('never_connected');
  });
});

describe('resolveCurrentRequirement (ENG-2016 AC1)', () => {
  it('treats only contracted, a recent verified ads action, or recent spend as a current requirement', () => {
    expect(resolveCurrentRequirement({ requirementSource: 'contracted' }, null, NOW).status).toBe('required');
    expect(
      resolveCurrentRequirement({ requirementSource: 'recent_ads_action', requirementVerifiedAt: ago(5 * DAY_MS) }, null, NOW).status,
    ).toBe('required');
    expect(resolveCurrentRequirement(null, 120, NOW).evidence.code).toBe('requirement_recent_spend');

    expect(
      resolveCurrentRequirement({ requirementSource: 'recent_ads_action', requirementVerifiedAt: ago(31 * DAY_MS) }, 0, NOW).status,
    ).toBe('unknown');
    expect(resolveCurrentRequirement({ requirementSource: 'onboarding_intent' }, 0, NOW).status).toBe('unknown');
    // Absent field (today's 7 prod rows) and absent row are both unknown.
    expect(resolveCurrentRequirement({}, null, NOW).status).toBe('unknown');
    expect(resolveCurrentRequirement(null, null, NOW).status).toBe('unknown');
  });
});

describe('never connected is activation, never at-risk (ENG-2133 / D6)', () => {
  it('classifies a never-connected account as activation_incomplete even with a contracted requirement', () => {
    const plain = classifyAccountHealth(signals({ connectedAccounts: [] }));
    expect(plain).toMatchObject({ state: 'activation_incomplete', confidence: 'high' });

    const contracted = classifyAccountHealth(signals({ connectedAccounts: [], requirement: { requirementSource: 'contracted' } }));
    expect(contracted.state).toBe('activation_incomplete');
    expect(contracted.evidence.map((e) => e.code)).toContain('requirement_contracted');
  });

  it('still reports a real risk on a never-connected account (a failed payment is not about ads)', () => {
    const result = classifyAccountHealth(
      signals({ connectedAccounts: [], payments: [{ eventType: 'payment_failed', timestamp: ago(DAY_MS) }] }),
    );
    expect(result.state).toBe('at_risk');
    expect(result.evidence.filter((e) => e.kind === 'risk').map((e) => e.code)).toEqual(['payment_failed']);
  });
});

describe('ENG-2016 AC7 regression fixtures (classification)', () => {
  it('xCures-like: only stale onboarding intent, no ad account → not at-risk', () => {
    const result = classifyAccountHealth(
      signals({ connectedAccounts: [], requirement: { requirementSource: 'onboarding_intent' } }),
    );
    expect(result.state).toBe('activation_incomplete');
  });

  it('stale onboarding intent with an expired connection fails closed to insufficient_evidence (AC2)', () => {
    const result = classifyAccountHealth(
      signals({ connectedAccounts: [expiredMeta], requirement: { requirementSource: 'onboarding_intent' } }),
    );
    expect(result).toMatchObject({ state: 'insufficient_evidence', confidence: 'low', requirement: 'unknown' });
  });

  it('current ads work plan + disconnected ads → at_risk', () => {
    const result = classifyAccountHealth(
      signals({
        connectedAccounts: [expiredMeta],
        requirement: { requirementSource: 'recent_ads_action', requirementVerifiedAt: ago(3 * DAY_MS) },
      }),
    );
    expect(result).toMatchObject({ state: 'at_risk', confidence: 'medium' });
    expect(result.evidence.find((e) => e.code === 'ads_connection_expired')?.kind).toBe('risk');
  });

  it('explicitly required ads still alerts despite active usage elsewhere (AC5)', () => {
    const result = classifyAccountHealth(
      signals({
        connectedAccounts: [expiredMeta, { platform: 'linkedin', config: {} }],
        requirement: { requirementSource: 'contracted' },
        lastActiveAt: ago(HOUR_MS),
      }),
    );
    expect(result).toMatchObject({ state: 'at_risk', confidence: 'high' });
    expect(result.evidence.map((e) => e.code)).toContain('recently_active');
  });
});

describe('missing evidence is stated, never a confident verdict (brain F15)', () => {
  it('returns insufficient_evidence when payment history was not read', () => {
    expect(classifyAccountHealth(signals({ payments: null }))).toMatchObject({
      state: 'insufficient_evidence',
      confidence: 'low',
    });
  });

  it('does not read unread delivery as zero delivery', () => {
    const result = classifyAccountHealth(signals({ campaigns: null }));
    expect(result).toMatchObject({ state: 'healthy', confidence: 'medium' });
    expect(result.evidence.find((e) => e.code === 'delivery_not_read')?.kind).toBe('gap');
  });

  it('does not read an empty payment history as a failure', () => {
    expect(classifyAccountHealth(signals({ payments: [] }))).toMatchObject({ state: 'healthy', confidence: 'high' });
  });
});

describe('payments', () => {
  it('flags an unresolved payment failure and a past-due subscription, not a resolved one', () => {
    expect(codes(signals({ payments: [{ eventType: 'payment_failed', timestamp: ago(2 * DAY_MS) }] }))).toContain('payment_failed');
    expect(
      classifyAccountHealth(
        signals({
          payments: [
            { eventType: 'payment_failed', timestamp: ago(3 * DAY_MS) },
            { eventType: 'payment_succeeded', timestamp: ago(DAY_MS) },
          ],
        }),
      ).state,
    ).toBe('healthy');
    expect(classifyAccountHealth(signals({ payments: [{ eventType: 'payment_failed', timestamp: ago(40 * DAY_MS) }] })).state).toBe('healthy');
    // A retry that succeeded in the same instant resolves the failure.
    expect(
      classifyAccountHealth(
        signals({
          payments: [
            { eventType: 'payment_failed', timestamp: ago(DAY_MS) },
            { eventType: 'payment_succeeded', timestamp: ago(DAY_MS) },
          ],
        }),
      ).state,
    ).toBe('healthy');
    expect(classifyAccountHealth(signals({ subscriptionStatus: 'past_due' }))).toMatchObject({ state: 'at_risk', confidence: 'high' });
    // A failure after the evaluation time (backtest cutoff) is not visible yet.
    expect(classifyAccountHealth(signals({ payments: [{ eventType: 'payment_failed', timestamp: new Date(NOW + DAY_MS).toISOString() }] })).state).toBe('healthy');
  });
});

describe('ENG-1913 zero delivery', () => {
  const campaign = (overrides: Partial<CampaignDeliveryInput> = {}): CampaignDeliveryInput => ({
    campaignId: 'c1',
    status: 'ENABLED',
    approvedDailyBudget: 50,
    liveSince: ago(3 * DAY_MS),
    impressions: 0,
    clicks: 0,
    ...overrides,
  });

  it('AC1: enabled, approved budget, zero impressions/clicks past 24h → flagged', () => {
    expect(evaluateZeroDelivery([campaign()], NOW).stuck).toEqual(['c1']);
    expect(classifyAccountHealth(signals({ campaigns: [campaign()] }))).toMatchObject({ state: 'at_risk', confidence: 'high' });
  });

  it('AC2: a delivering campaign is not flagged', () => {
    const result = evaluateZeroDelivery([campaign({ impressions: 4200, clicks: 61 })], NOW);
    expect(result).toMatchObject({ stuck: [], delivering: ['c1'] });
    expect(classifyAccountHealth(signals({ campaigns: [campaign({ impressions: 4200, clicks: 61 })] })).state).toBe('healthy');
  });

  it('AC3: an intentionally paused campaign is not flagged', () => {
    expect(evaluateZeroDelivery([campaign({ status: 'PAUSED' })], NOW)).toMatchObject({ stuck: [], excluded: ['c1'] });
    expect(classifyAccountHealth(signals({ campaigns: [campaign({ status: 'PAUSED' })] })).state).toBe('healthy');
  });

  it('AC4: a campaign inside its first 24h is warming up, not stuck', () => {
    const young = campaign({ liveSince: ago(23 * HOUR_MS) });
    expect(evaluateZeroDelivery([young], NOW)).toMatchObject({ stuck: [], warmingUp: ['c1'] });
    expect(classifyAccountHealth(signals({ campaigns: [young] })).state).toBe('healthy');
    expect(evaluateZeroDelivery([campaign({ liveSince: ago(25 * HOUR_MS) })], NOW).stuck).toEqual(['c1']);
  });

  it('AC5: the ENG-1738 incident shape (3 enabled campaigns, $100/day combined, keywords paused, 7 days of nothing) flags on day 1', () => {
    // Campaigns stayed ENABLED; the pause was on every keyword underneath, which the campaign
    // status does not show, so they must still count as stuck.
    const liveAt = NOW - 7 * DAY_MS;
    const liveSince = new Date(liveAt).toISOString();
    const incident = [
      campaign({ campaignId: 'core', approvedDailyBudget: 40, liveSince }),
      campaign({ campaignId: 'competitor', approvedDailyBudget: 30, liveSince }),
      campaign({ campaignId: 'exact-intent', approvedDailyBudget: 30, liveSince }),
    ];
    expect(evaluateZeroDelivery(incident, liveAt + 12 * HOUR_MS).stuck).toEqual([]);
    // Day 1: the first check past the grace window flags all three, not a week later.
    expect(evaluateZeroDelivery(incident, liveAt + 25 * HOUR_MS).stuck).toEqual(['core', 'competitor', 'exact-intent']);
    expect(classifyAccountHealth(signals({ campaigns: incident })).evidence.find((e) => e.code === 'zero_delivery')?.detail).toMatch(/^3 enabled/);
  });

  it('excludes a zero-budget or removed campaign and accepts Meta ACTIVE', () => {
    expect(evaluateZeroDelivery([campaign({ approvedDailyBudget: 0 }), campaign({ campaignId: 'c2', status: 'REMOVED' })], NOW).excluded).toEqual([
      'c1',
      'c2',
    ]);
    expect(evaluateZeroDelivery([campaign({ status: 'ACTIVE' })], NOW).stuck).toEqual(['c1']);
  });
});

describe('billingCycleKey', () => {
  it('uses the period end date, else the UTC month', () => {
    expect(billingCycleKey('2026-10-10T08:00:00.000Z', NOW)).toBe('2026-10-10');
    expect(billingCycleKey(undefined, NOW)).toBe('month:2026-09');
    expect(billingCycleKey('not a date', NOW)).toBe('month:2026-09');
  });
});

/** `days` consecutive collected days ending the day before NOW, oldest first. */
function adDays(days: number, spendFor: (daysAgo: number) => number, leadsFor: (daysAgo: number) => number = () => 0): AdDayInput[] {
  const out: AdDayInput[] = [];
  for (let daysAgo = days; daysAgo >= 1; daysAgo--) {
    out.push({ date: new Date(NOW - daysAgo * DAY_MS).toISOString().slice(0, 10), spend: spendFor(daysAgo), leads: leadsFor(daysAgo) });
  }
  return out;
}

describe('buildAdDays (account-day rows carry spend 0; spend comes from campaign rows)', () => {
  it('marks account-day dates as collected, sums campaign spend and account-day leads per date', () => {
    expect(buildAdDays(
      [{ date: '2026-09-01', totalLeadCount: 2 }, { date: '2026-09-01', totalLeadCount: 1 }, { date: '2026-09-02', totalLeadCount: 0 }],
      [{ date: '2026-09-01', spend: 10 }, { date: '2026-09-01', spend: 5 }, { date: '2026-09-03', spend: 7 }],
    )).toEqual([
      { date: '2026-09-01', spend: 15, leads: 3 },
      { date: '2026-09-02', spend: 0, leads: 0 },
      { date: '2026-09-03', spend: 7, leads: 0 },
    ]);
  });
});

describe('ad trend: spend drop and results drop (ENG-2143 audit)', () => {
  it('flags spend cut by half or more against the prior 14 days', () => {
    const [evidence] = evaluateAdTrend(adDays(28, (d) => (d > 14 ? 100 : 40)), NOW);
    expect(evidence).toMatchObject({ code: 'spend_drop', kind: 'risk' });
    expect(evidence.detail).toContain('fell 60%');
  });

  it('does not flag a smaller dip', () => {
    expect(evaluateAdTrend(adDays(28, (d) => (d > 14 ? 100 : 60)), NOW).map((e) => e.code)).toEqual(['ad_trend_steady']);
  });

  it('flags leads that stopped while spend continued, only against a real lead baseline', () => {
    const stopped = evaluateAdTrend(adDays(28, () => 50, (d) => (d > 14 && d % 4 === 0 ? 1 : 0)), NOW);
    expect(stopped.map((e) => e.code)).toEqual(['results_drop']);
    // Never had leads: nothing to compare, so no results verdict.
    expect(evaluateAdTrend(adDays(28, () => 50), NOW).map((e) => e.code)).toEqual(['ad_trend_steady']);
  });

  it('does not judge a trend from too few collected days, or without prior spend (unread is not zero)', () => {
    expect(evaluateAdTrend(adDays(20, (d) => (d > 14 ? 100 : 0)), NOW).map((e) => e.code)).toEqual(['ad_trend_not_evaluable']);
    expect(evaluateAdTrend(adDays(28, () => 0), NOW).map((e) => e.code)).toEqual(['ad_trend_not_evaluable']);
  });

  it('a spend drop makes a connected account at_risk (medium confidence); unread metrics decide nothing', () => {
    const result = classifyAccountHealth(signals({ adDays: adDays(28, (d) => (d > 14 ? 100 : 0)) }));
    expect(result).toMatchObject({ state: 'at_risk', confidence: 'medium' });
    expect(classifyAccountHealth(signals({ adDays: null })).state).toBe('healthy');
    expect(codes(signals({ adDays: null }))).toContain('ad_trend_not_evaluable');
  });
});

describe('explicit negative feedback', () => {
  const rating = (type: string, daysAgo: number) => ({ type, timestamp: ago(daysAgo * DAY_MS) });

  it('is a risk when thumbs-down are at least 3 and outnumber thumbs-up in the last 30 days', () => {
    expect(evaluateFeedback([rating('dislike', 1), rating('dislike', 2), rating('dislike', 3), rating('like', 4)], NOW))
      .toMatchObject({ code: 'negative_feedback', kind: 'risk' });
    expect(classifyAccountHealth(signals({ feedback: [rating('dislike', 1), rating('dislike', 2), rating('dislike', 3)] })).state)
      .toBe('at_risk');
  });

  it('ignores ratings outside the window and a thumbs-up majority', () => {
    expect(evaluateFeedback([rating('dislike', 31), rating('dislike', 40), rating('dislike', 45)], NOW).code).toBe('feedback_clear');
    expect(evaluateFeedback([rating('dislike', 1), rating('dislike', 2), rating('dislike', 3), ...[1, 2, 3].map((d) => rating('like', d))], NOW).code)
      .toBe('feedback_clear');
  });
});

describe('pixel tracking is activation evidence, never risk (D6)', () => {
  it('a connected account whose ads land on pages without an owned pixel is activation_incomplete', () => {
    const result = classifyAccountHealth(signals({ tracking: { destinationsWithoutOwnedPixel: 2, landingPagesWithoutOwnedPixel: 0 } }));
    expect(result).toMatchObject({ state: 'activation_incomplete', confidence: 'medium' });
    expect(result.evidence.find((e) => e.code === 'tracking_not_set_up')?.kind).toBe('activation');
  });

  it('owned pixels, or an unread check, leave the account healthy', () => {
    expect(classifyAccountHealth(signals({ tracking: { destinationsWithoutOwnedPixel: 0, landingPagesWithoutOwnedPixel: 0 } })).state).toBe('healthy');
    expect(codes(signals({ tracking: null }))).toContain('tracking_not_read');
  });

  it('a real risk still wins over tracking setup', () => {
    const result = classifyAccountHealth(signals({
      subscriptionStatus: 'past_due',
      tracking: { destinationsWithoutOwnedPixel: 1, landingPagesWithoutOwnedPixel: 1 },
    }));
    expect(result.state).toBe('at_risk');
  });
});
