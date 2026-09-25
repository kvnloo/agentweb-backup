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
  return { users: [], payments: [], requirements: new Map(), spend: [], ...overrides };
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
      { cutoff: '2026-06-01', truth: 'churned', state: 'at_risk' },
      { cutoff: '2026-06-01', truth: 'retained', state: 'activation_incomplete' },
      { cutoff: '2026-06-01', truth: 'retained', state: 'activation_incomplete' },
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

describe('scoreBacktest', () => {
  it('reports precision/recall with Wilson CIs and a state-by-truth table', () => {
    const metrics = scoreBacktest([
      { cutoff: 'c', truth: 'churned', state: 'at_risk' },
      { cutoff: 'c', truth: 'churned', state: 'activation_incomplete' },
      { cutoff: 'c', truth: 'retained', state: 'healthy' },
      { cutoff: 'c', truth: 'retained', state: 'at_risk' },
    ]);
    expect(metrics).toMatchObject({ n: 4, positives: 2, predictedPositives: 2, tp: 1, precision: 0.5, recall: 0.5 });
    expect(metrics.precisionCI?.low).toBeCloseTo(0.0945, 3);
    expect(metrics.precisionCI?.high).toBeCloseTo(0.9055, 3);
    expect(metrics.stateByTruth.churned).toEqual({ activation_incomplete: 1, at_risk: 1, healthy: 0, insufficient_evidence: 0 });
  });

  it('reports n/a rather than a number when nothing was predicted or nothing churned', () => {
    const metrics = scoreBacktest([{ cutoff: 'c', truth: 'retained', state: 'healthy' }]);
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
