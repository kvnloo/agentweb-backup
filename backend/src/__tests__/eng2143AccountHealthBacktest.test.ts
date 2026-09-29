/**
 * ENG-2143 backtest: population rules (no outcome leakage, undated and already-churned accounts
 * excluded), cutoff windows, and precision/recall with Wilson CIs from agreement.ts.
 */
import {
  buildCutoffPopulation,
  scoreBacktest,
  defaultCutoffs,
  type BacktestData,
} from '../scripts/eng2143-account-health-backtest';

const DAY_MS = 24 * 60 * 60 * 1000;
const C = Date.parse('2026-06-01T00:00:00.000Z');
const at = (days: number) => new Date(C + days * DAY_MS).toISOString();

function data(overrides: Partial<BacktestData> = {}): BacktestData {
  return { users: [], payments: [], requirements: new Map(), spend: [], accountDays: [], feedback: [], ...overrides };
}

describe('buildCutoffPopulation', () => {
  it('labels churn from dated cancellations inside the horizon and never reads current status', () => {
    const result = buildCutoffPopulation(
      data({
        users: [
          // Canceled today, but a payment failure before C is the only signal the classifier may see.
          { userId: 'churner', createdAt: at(-90), subscription_status: 'canceled' },
          // Past-due today: must not leak into the as-of-C classification.
          { userId: 'stayer', createdAt: at(-90), subscription_status: 'past_due', connected_accounts: [] },
          { userId: 'later', createdAt: at(-90), subscription_status: 'canceled' },
        ],
        payments: [
          { userId: 'churner', timestamp: at(-5), eventType: 'payment_failed' },
          { userId: 'churner', timestamp: at(10), eventType: 'subscription_canceled' },
          { userId: 'later', timestamp: at(-40), eventType: 'payment_succeeded' },
          { userId: 'later', timestamp: at(45), eventType: 'subscription_canceled' },
        ],
      }),
      C,
      30 * DAY_MS,
    );
    expect(result.cases).toEqual([
      { cutoff: '2026-06-01', truth: 'churned', state: 'at_risk', signals: ['payment_failed', 'ads_never_connected'] },
      { cutoff: '2026-06-01', truth: 'retained', state: 'activation_incomplete', signals: ['ads_never_connected'] },
      { cutoff: '2026-06-01', truth: 'retained', state: 'activation_incomplete', signals: ['ads_never_connected'] },
    ]);
  });

  it('excludes undated cancellations, accounts already churned, and accounts not yet paying', () => {
    const result = buildCutoffPopulation(
      data({
        users: [
          { userId: 'undated', createdAt: at(-90), subscription_status: 'canceled' },
          { userId: 'gone', createdAt: at(-90), subscription_status: 'canceled' },
          { userId: 'back', createdAt: at(-90), subscription_status: 'active' },
          { userId: 'new', createdAt: at(-90), subscription_status: 'active' },
          { userId: 'future', createdAt: at(5), subscription_status: 'active' },
          { userId: 'free', createdAt: at(-90) },
        ],
        payments: [
          // 'undated' has Stripe activity but no cancel event, so its cancellation cannot be placed.
          { userId: 'undated', timestamp: at(-40), eventType: 'payment_succeeded' },
          { userId: 'gone', timestamp: at(-3), eventType: 'subscription_canceled' },
          { userId: 'back', timestamp: at(-3), eventType: 'subscription_canceled' },
          { userId: 'back', timestamp: at(-1), eventType: 'payment_succeeded' },
          { userId: 'new', timestamp: at(3), eventType: 'subscription_created' },
        ],
      }),
      C,
      30 * DAY_MS,
    );
    expect(result).toMatchObject({ excludedUndatedCancel: 1, excludedAlreadyChurned: 1, excludedNotYetPaying: 1 });
    expect(result.cases).toHaveLength(1);
  });

  it('does not count a failed checkout before the cutoff as paying when the first subscription starts after it', () => {
    const result = buildCutoffPopulation(
      data({
        users: [{ userId: 'late', createdAt: at(-90), subscription_status: 'active' }],
        payments: [
          { userId: 'late', timestamp: at(-2), eventType: 'payment_failed' },
          { userId: 'late', timestamp: at(4), eventType: 'subscription_created' },
        ],
      }),
      C,
      30 * DAY_MS,
    );
    expect(result).toMatchObject({ excludedNotYetPaying: 1, cases: [] });
  });

  it('counts ad spend over the 30 complete days before the cutoff, not the cutoff day itself', () => {
    const spendOn = (date: string) => ({ userId: 'u', date, spend: 10 });
    const expired = { platform: 'meta', created_at: at(-60), config: { account_type: 'ad_account', token_expires_at: C - DAY_MS } };
    const population = (date: string) =>
      buildCutoffPopulation(
        data({
          users: [{ userId: 'u', createdAt: at(-90), subscription_status: 'active', connected_accounts: [expired] }],
          // An early row so the snapshot history covers the whole window.
          spend: [spendOn('2026-03-01'), spendOn(date)],
        }),
        C,
        30 * DAY_MS,
      ).cases[0].state;
    // Spend inside the window makes the requirement current, so the expired connection is at risk.
    expect(population('2026-05-02')).toBe('at_risk');
    expect(population('2026-05-31')).toBe('at_risk');
    // The cutoff day has not happened yet at C; the day before the window is out of it.
    expect(population('2026-06-01')).toBe('insufficient_evidence');
    expect(population('2026-05-01')).toBe('insufficient_evidence');
  });

  it('excludes an account whose ad connection has no created_at, since it may postdate the cutoff', () => {
    const result = buildCutoffPopulation(
      data({
        users: [
          {
            userId: 'undated',
            createdAt: at(-90),
            subscription_status: 'active',
            connected_accounts: [{ platform: 'meta', config: { account_type: 'ad_account', token_expires_at: C + 90 * DAY_MS } }],
          },
          // A non-ad connection without a date does not matter to the classifier.
          { userId: 'social', createdAt: at(-90), subscription_status: 'active', connected_accounts: [{ platform: 'linkedin', config: {} }] },
        ],
      }),
      C,
      30 * DAY_MS,
    );
    expect(result.excludedUndatedConnection).toBe(1);
    expect(result.cases).toHaveLength(1);
  });

  it('judges ad tokens and connections as of the cutoff', () => {
    const meta = (tokenExpiresAt: number, createdAt: string) => ({
      platform: 'meta',
      created_at: createdAt,
      config: { account_type: 'ad_account', token_expires_at: tokenExpiresAt },
    });
    const result = buildCutoffPopulation(
      data({
        users: [
          // Expired today, but still valid at C.
          { userId: 'valid-then', createdAt: at(-90), subscription_status: 'active', connected_accounts: [meta(C + 10 * DAY_MS, at(-30))] },
          // Connected only after C: never connected as of C.
          { userId: 'connected-later', createdAt: at(-90), subscription_status: 'active', connected_accounts: [meta(C + 90 * DAY_MS, at(3))] },
        ],
      }),
      C,
      30 * DAY_MS,
    );
    expect(result.cases.map((c) => c.state)).toEqual(['healthy', 'activation_incomplete']);
  });
});

describe('buildCutoffPopulation: behavioural signals and cancellation dating (ENG-2143 audit)', () => {
  const liveMeta = { platform: 'meta', created_at: at(-60), config: { account_type: 'ad_account', token_expires_at: C + 90 * DAY_MS } };
  const day = (daysBefore: number) => at(-daysBefore).slice(0, 10);

  it('places a cancellation with no Stripe event, from an account created before the payment log, before the log', () => {
    const result = buildCutoffPopulation(
      data({
        users: [
          { userId: 'pre-log', createdAt: at(-200), subscription_status: 'canceled' },
          // Created after the log began: it cannot have canceled before it, so it stays undated.
          { userId: 'post-log', createdAt: at(-50), subscription_status: 'canceled' },
          // An admin credit grant is not a Stripe event.
          { userId: 'credited', createdAt: at(-200), subscription_status: 'canceled' },
        ],
        payments: [
          { userId: 'someone-else', timestamp: at(-100), eventType: 'payment_succeeded' },
          { userId: 'credited', timestamp: at(-20), eventType: 'admin_credit_grant' },
        ],
      }),
      C,
      30 * DAY_MS,
    );
    expect(result).toMatchObject({ canceledBeforePaymentLog: 2, excludedUndatedCancel: 1 });
    expect(result.cases).toHaveLength(0);
  });

  it('reads spend from campaign rows (account-day rows store 0) and flags a spend drop as of the cutoff', () => {
    const accountDays = Array.from({ length: 28 }, (_, i) => ({ userId: 'u', date: day(i + 1), totalLeadCount: 0 }));
    const spend = Array.from({ length: 28 }, (_, i) => ({ userId: 'u', date: day(i + 1), spend: i + 1 > 14 ? 100 : 10 }));
    // After the cutoff: must not be seen.
    spend.push({ userId: 'u', date: at(2).slice(0, 10), spend: 5000 });
    const result = buildCutoffPopulation(
      data({
        users: [{ userId: 'u', createdAt: at(-90), subscription_status: 'active', connected_accounts: [liveMeta] }],
        payments: [{ userId: 'u', timestamp: at(-10), eventType: 'payment_succeeded' }],
        spend,
        accountDays,
      }),
      C,
      30 * DAY_MS,
    );
    expect(result.cases).toEqual([{ cutoff: '2026-06-01', truth: 'retained', state: 'at_risk', signals: ['spend_drop'] }]);
  });

  it('counts explicit ratings only up to the cutoff', () => {
    const dislike = (days: number) => ({ userId: 'u', type: 'dislike', timestamp: at(days) });
    const build = (feedback: ReturnType<typeof dislike>[]) => buildCutoffPopulation(
      data({
        users: [{ userId: 'u', createdAt: at(-90), subscription_status: 'active', connected_accounts: [liveMeta] }],
        payments: [{ userId: 'u', timestamp: at(-10), eventType: 'payment_succeeded' }],
        feedback,
      }),
      C,
      30 * DAY_MS,
    ).cases[0];
    expect(build([dislike(-1), dislike(-2), dislike(-3)])).toMatchObject({ state: 'at_risk', signals: ['negative_feedback'] });
    expect(build([dislike(1), dislike(2), dislike(3)])).toMatchObject({ state: 'healthy', signals: [] });
  });
});

describe('scoreBacktest', () => {
  it('reports precision/recall with Wilson CIs and a state-by-truth table', () => {
    const metrics = scoreBacktest([
      { cutoff: 'c', truth: 'churned', state: 'at_risk', signals: [] },
      { cutoff: 'c', truth: 'churned', state: 'activation_incomplete', signals: [] },
      { cutoff: 'c', truth: 'retained', state: 'healthy', signals: [] },
      { cutoff: 'c', truth: 'retained', state: 'at_risk', signals: [] },
    ]);
    expect(metrics).toMatchObject({ n: 4, positives: 2, predictedPositives: 2, tp: 1, precision: 0.5, recall: 0.5 });
    expect(metrics.precisionCI?.low).toBeCloseTo(0.0945, 3);
    expect(metrics.precisionCI?.high).toBeCloseTo(0.9055, 3);
    expect(metrics.stateByTruth.churned).toEqual({ activation_incomplete: 1, at_risk: 1, healthy: 0, insufficient_evidence: 0 });
  });

  it('reports n/a rather than a number when nothing was predicted or nothing churned', () => {
    const metrics = scoreBacktest([{ cutoff: 'c', truth: 'retained', state: 'healthy', signals: [] }]);
    expect(metrics).toMatchObject({ precision: null, precisionCI: null, recall: null, recallCI: null });
    expect(scoreBacktest([])).toMatchObject({ n: 0, precision: null, recall: null });
  });
});

describe('defaultCutoffs', () => {
  it('builds back-to-back windows ending today, starting no earlier than the first event', () => {
    const now = Date.parse('2026-09-25T15:00:00.000Z');
    const cutoffs = defaultCutoffs(30 * DAY_MS, now, Date.parse('2026-06-01T00:00:00.000Z'));
    expect(cutoffs.map((c) => new Date(c).toISOString().slice(0, 10))).toEqual(['2026-06-27', '2026-07-27', '2026-08-26']);
  });
});

describe('scoreBacktest signal counts', () => {
  it('reports how many pairs each signal fired on and how many of those churned', () => {
    const metrics = scoreBacktest([
      { cutoff: 'c', truth: 'churned', state: 'at_risk', signals: ['spend_drop', 'spend_drop'] },
      { cutoff: 'c', truth: 'retained', state: 'at_risk', signals: ['spend_drop'] },
      { cutoff: 'c', truth: 'retained', state: 'activation_incomplete', signals: ['ads_never_connected'] },
    ]);
    expect(metrics.signalCounts).toEqual({
      spend_drop: { fired: 2, churned: 1 },
      ads_never_connected: { fired: 1, churned: 0 },
    });
  });
});
