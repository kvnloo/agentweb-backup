/**
 * ENG-2143: routing and dedupe of account-health signals. Covers ENG-2016 AC3 (once per account +
 * billing cycle, again on a material transition), AC4 (correction suppression), AC7 (repeated
 * runs emit once; reconnect then disconnect emits a new alert), decision D6 (activation → CS,
 * never oncall), and the ACCOUNT_HEALTH_ALERTS_ENABLED gate.
 */

jest.mock('../services/db', () => ({ userDb: { scanWithFilter: jest.fn() } }));
jest.mock('../services/paymentHistoryDb', () => ({ paymentHistoryDb: { getByUserId: jest.fn() } }));
jest.mock('../services/adsMetricsDb', () => ({ adsMetricsDb: { getAccountDaySnapshots: jest.fn() } }));
jest.mock('../utils/agentModeAlerts', () => ({ sendAgentModeOncallAlert: jest.fn() }));
jest.mock('../services/accountCapabilityRequirementsDb', () => ({
  getAccountCapabilityRequirement: jest.fn(),
  getAccountHealthSignalState: jest.fn(),
  putAccountHealthSignalState: jest.fn(),
  isSuppressed: jest.fn(),
}));
jest.mock('../loops/eval/evalRegistry', () => ({ mayGate: jest.fn() }));
jest.mock('../utils/instanceState', () => ({ isCronEnabled: jest.fn() }));

import { userDb } from '../services/db';
import { paymentHistoryDb, type PaymentHistoryRecord } from '../services/paymentHistoryDb';
import { adsMetricsDb } from '../services/adsMetricsDb';
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';
import {
  getAccountCapabilityRequirement,
  getAccountHealthSignalState,
  putAccountHealthSignalState,
  isSuppressed,
  type AccountCapabilityRequirement,
  type AccountHealthSignalState,
} from '../services/accountCapabilityRequirementsDb';
import { decideAccountHealthSignal, runAccountHealthClassifier, type AccountHealthUser } from '../cron/accountHealthClassifierCron';
import { classifyAccountHealth, type AccountHealthSignals } from '../services/accountHealthClassifier';
import { mayGate } from '../loops/eval/evalRegistry';
import { isCronEnabled } from '../utils/instanceState';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const expiredMeta = { platform: 'meta', config: { account_type: 'ad_account', token_expires_at: NOW - 3 * DAY_MS } };
const liveMeta = { platform: 'meta', config: { account_type: 'ad_account', token_expires_at: NOW + 30 * DAY_MS } };

function classify(overrides: Partial<AccountHealthSignals> = {}, nowMs: number = NOW) {
  return classifyAccountHealth({
    nowMs,
    connectedAccounts: [expiredMeta],
    requirement: { requirementSource: 'contracted' },
    subscriptionStatus: 'active',
    currentPeriodEnd: '2026-10-10T00:00:00.000Z',
    payments: [],
    campaigns: null,
    recentAdSpend: 0,
    lastActiveAt: iso(nowMs - DAY_MS),
    ...overrides,
  });
}

/** Runs `decide` over a sequence of classifications, persisting `next` like the cron does. */
function replay(results: Array<{ at: number; overrides?: Partial<AccountHealthSignals> }>) {
  let state: AccountHealthSignalState | null = null;
  return results.map(({ at, overrides }) => {
    const decision = decideAccountHealthSignal(state, classify(overrides, at), iso(at), { oncallAllowed: true });
    if (decision.next) state = decision.next;
    return decision;
  });
}

describe('decideAccountHealthSignal', () => {
  it('ENG-2016 AC7: repeated unchanged at-risk runs in one billing cycle emit once', () => {
    const decisions = replay([0, 1, 2, 3, 4].map((d) => ({ at: NOW + d * DAY_MS })));
    expect(decisions.map((d) => [d.channel, d.emit])).toEqual([
      ['oncall', true],
      ['oncall', false],
      ['oncall', false],
      ['oncall', false],
      ['oncall', false],
    ]);
    expect(decisions.slice(1).every((d) => d.next === null)).toBe(true);
  });

  it('ENG-2016 AC7: reconnect then disconnect emits a new state-change alert', () => {
    const decisions = replay([
      { at: NOW },
      { at: NOW + DAY_MS, overrides: { connectedAccounts: [liveMeta] } },
      { at: NOW + 2 * DAY_MS },
    ]);
    expect(decisions.map((d) => [d.channel, d.emit, d.reason])).toEqual([
      ['oncall', true, 'new_episode'],
      ['none', false, 'new_episode'],
      ['oncall', true, 'new_episode'],
    ]);
  });

  it('ENG-2016 AC3: a new billing cycle re-emits; new risk evidence re-emits; lost evidence does not', () => {
    const decisions = replay([
      { at: NOW },
      { at: NOW + DAY_MS, overrides: { payments: [{ eventType: 'payment_failed', timestamp: iso(NOW + DAY_MS - 1000) }] } },
      { at: NOW + 2 * DAY_MS },
      { at: NOW + 3 * DAY_MS, overrides: { currentPeriodEnd: '2026-11-10T00:00:00.000Z' } },
    ]);
    expect(decisions.map((d) => [d.emit, d.reason])).toEqual([
      [true, 'new_episode'],
      [true, 'new_evidence'],
      [false, 'unchanged'],
      [true, 'new_billing_cycle'],
    ]);
  });

  it('a transient unread signal does not end an at-risk episode (no re-alert on the next good read)', () => {
    const decisions = replay([
      { at: NOW, overrides: { payments: [{ eventType: 'payment_failed', timestamp: iso(NOW - DAY_MS) }] } },
      { at: NOW + DAY_MS, overrides: { payments: null, requirement: null } },
      { at: NOW + 2 * DAY_MS, overrides: { payments: [{ eventType: 'payment_failed', timestamp: iso(NOW - DAY_MS) }] } },
    ]);
    expect(decisions.map((d) => [d.channel, d.emit])).toEqual([
      ['oncall', true],
      ['needs_review', false],
      ['oncall', false],
    ]);
  });

  it('D6: activation_incomplete goes to the CS nudge, never oncall, once per cycle', () => {
    const decisions = replay([
      { at: NOW, overrides: { connectedAccounts: [] } },
      { at: NOW + DAY_MS, overrides: { connectedAccounts: [] } },
    ]);
    expect(decisions.map((d) => [d.channel, d.emit])).toEqual([
      ['cs_nudge', true],
      ['cs_nudge', false],
    ]);
  });

  it('AC2: insufficient evidence goes to needs-review, never oncall', () => {
    const [decision] = replay([{ at: NOW, overrides: { requirement: { requirementSource: 'onboarding_intent' } } }]);
    expect(decision).toMatchObject({ channel: 'needs_review', emit: true });
  });

  it('AC4: when a correction lapses mid-episode the same risk escalates to oncall once', () => {
    const result = classify();
    const first = decideAccountHealthSignal(null, result, iso(NOW), { correctionActive: true, oncallAllowed: true });
    expect(first).toMatchObject({ channel: 'needs_review', emit: true });
    const lapsed = decideAccountHealthSignal(first.next, classify({}, NOW + DAY_MS), iso(NOW + DAY_MS), { oncallAllowed: true });
    expect(lapsed).toMatchObject({ channel: 'oncall', emit: true, reason: 'escalated' });
    const repeat = decideAccountHealthSignal(lapsed.next, classify({}, NOW + 2 * DAY_MS), iso(NOW + 2 * DAY_MS), { oncallAllowed: true });
    expect(repeat).toMatchObject({ channel: 'oncall', emit: false, reason: 'unchanged' });
  });

  it('AC4: an active correction downgrades a connection-only risk, but not a payment risk', () => {
    const expired = classify();
    expect(decideAccountHealthSignal(null, expired, iso(NOW), { correctionActive: true, oncallAllowed: true }).channel).toBe('needs_review');
    const paymentAndExpired = classify({ payments: [{ eventType: 'payment_failed', timestamp: iso(NOW - DAY_MS) }] });
    expect(decideAccountHealthSignal(null, paymentAndExpired, iso(NOW), { correctionActive: true, oncallAllowed: true }).channel).toBe('oncall');
  });
});

describe('runAccountHealthClassifier', () => {
  const store = new Map<string, AccountHealthSignalState>();
  const users: AccountHealthUser[] = [];
  const originalFlag = process.env.ACCOUNT_HEALTH_ALERTS_ENABLED;

  beforeEach(() => {
    jest.clearAllMocks();
    store.clear();
    users.length = 0;
    process.env.ACCOUNT_HEALTH_ALERTS_ENABLED = 'true';
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
    jest.mocked(userDb.scanWithFilter).mockImplementation(async () => users);
    const payments: PaymentHistoryRecord[] = [];
    jest.mocked(paymentHistoryDb.getByUserId).mockResolvedValue(payments);
    jest.mocked(adsMetricsDb.getAccountDaySnapshots).mockResolvedValue({ rows: [], truncated: false });
    const contracted: AccountCapabilityRequirement = {
      userId: 'u',
      capability: 'ad_platform_integration',
      requiredSince: iso(NOW - 90 * DAY_MS),
      source: 'paid_ads_intent',
      sourceDetail: 'goal',
      status: 'unhealthy',
      statusChangedAt: iso(NOW - 90 * DAY_MS),
      lastVerifiedAt: iso(NOW - DAY_MS),
      requirementSource: 'contracted',
    };
    jest.mocked(getAccountCapabilityRequirement).mockResolvedValue(contracted);
    jest.mocked(isSuppressed).mockReturnValue(false);
    jest.mocked(getAccountHealthSignalState).mockImplementation(async (userId) => store.get(userId) ?? null);
    jest.mocked(putAccountHealthSignalState).mockImplementation(async (userId, next, expected) => {
      if ((store.get(userId)?.version ?? null) !== expected) return false;
      store.set(userId, next);
      return true;
    });
    jest.mocked(sendAgentModeOncallAlert).mockResolvedValue(true);
    jest.mocked(mayGate).mockReturnValue(true);
    jest.mocked(isCronEnabled).mockReturnValue(true);
  });

  afterAll(() => {
    if (originalFlag === undefined) delete process.env.ACCOUNT_HEALTH_ALERTS_ENABLED;
    else process.env.ACCOUNT_HEALTH_ALERTS_ENABLED = originalFlag;
    jest.restoreAllMocks();
  });

  it('is inert with the flag unset: no scan, no write, no alert', async () => {
    delete process.env.ACCOUNT_HEALTH_ALERTS_ENABLED;
    users.push({ userId: 'u1', connected_accounts: [expiredMeta], subscription_status: 'active' });
    const summary = await runAccountHealthClassifier({ now: NOW });
    expect(summary.scanned).toBe(0);
    expect(userDb.scanWithFilter).not.toHaveBeenCalled();
    expect(putAccountHealthSignalState).not.toHaveBeenCalled();
    expect(sendAgentModeOncallAlert).not.toHaveBeenCalled();
  });

  it('does nothing on a draining instance (graceful shutdown disabled cron), including the first run', async () => {
    users.push({ userId: 'u1', connected_accounts: [expiredMeta], subscription_status: 'active' });
    jest.mocked(isCronEnabled).mockReturnValue(false);
    const summary = await runAccountHealthClassifier({ now: NOW });
    expect(summary.scanned).toBe(0);
    expect(userDb.scanWithFilter).not.toHaveBeenCalled();
    expect(putAccountHealthSignalState).not.toHaveBeenCalled();
    expect(sendAgentModeOncallAlert).not.toHaveBeenCalled();
  });

  it('a dry run classifies and captures without writing or alerting, even with the flag unset', async () => {
    delete process.env.ACCOUNT_HEALTH_ALERTS_ENABLED;
    users.push({ userId: 'u1', connected_accounts: [expiredMeta], subscription_status: 'active' });
    const summary = await runAccountHealthClassifier({ dryRun: true, now: NOW });
    expect(summary.captured).toEqual([expect.objectContaining({ userId: 'u1', state: 'at_risk', channel: 'oncall' })]);
    expect(putAccountHealthSignalState).not.toHaveBeenCalled();
    expect(sendAgentModeOncallAlert).not.toHaveBeenCalled();
  });

  it('alerts oncall once across repeated daily runs, with structured evidence', async () => {
    users.push({ userId: 'u1', email: 'owner@example.com', connected_accounts: [expiredMeta], subscription_status: 'active', current_period_end: '2026-10-10T00:00:00.000Z' });
    for (let day = 0; day < 3; day++) await runAccountHealthClassifier({ now: NOW + day * DAY_MS });
    expect(sendAgentModeOncallAlert).toHaveBeenCalledTimes(1);
    const alert = jest.mocked(sendAgentModeOncallAlert).mock.calls[0][0];
    expect(alert.userId).toBe('u1');
    expect(alert.context).toMatchObject({
      'Alert Class': 'account-health:u1',
      state: 'at_risk',
      confidence: 'high',
      billingCycle: '2026-10-10',
      reason: 'new_episode',
      codes: ['ads_connection_expired'],
    });
    expect(alert.message).toContain('Current ads requirement: required');
    expect(alert.message).toContain('Next actor: Customer: reconnect');
  });

  it('ENG-2128 principle 2: an unvalidated classifier never pages oncall; at_risk escalates once validated', async () => {
    users.push({ userId: 'u1', connected_accounts: [expiredMeta], subscription_status: 'active' });
    jest.mocked(mayGate).mockReturnValue(false);
    const gated = await runAccountHealthClassifier({ now: NOW });
    expect(mayGate).toHaveBeenCalledWith('account-health-classifier');
    expect(gated).toMatchObject({ oncall: 0, needsReview: 1 });
    expect(sendAgentModeOncallAlert).not.toHaveBeenCalled();
    expect(store.get('u1')?.lastSignalChannel).toBe('needs_review');

    jest.mocked(mayGate).mockReturnValue(true);
    expect(await runAccountHealthClassifier({ now: NOW + DAY_MS })).toMatchObject({ oncall: 1 });
    expect(jest.mocked(sendAgentModeOncallAlert).mock.calls[0][0].context).toMatchObject({ reason: 'escalated' });
  });

  it('never pages oncall for a never-connected account: CS nudge log line only', async () => {
    users.push({ userId: 'u2', connected_accounts: [], subscription_status: 'active' });
    const summary = await runAccountHealthClassifier({ now: NOW });
    expect(summary).toMatchObject({ csNudges: 1, oncall: 0 });
    expect(sendAgentModeOncallAlert).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('cs_nudge {"userId":"u2","state":"activation_incomplete"'));
  });

  it('does not alert when another instance claimed the signal first', async () => {
    users.push({ userId: 'u1', connected_accounts: [expiredMeta], subscription_status: 'active' });
    jest.mocked(putAccountHealthSignalState).mockResolvedValue(false);
    const summary = await runAccountHealthClassifier({ now: NOW });
    expect(summary.lostRace).toBe(1);
    expect(sendAgentModeOncallAlert).not.toHaveBeenCalled();
  });

  it('releases the claim when the send fails, so the next run retries', async () => {
    users.push({ userId: 'u1', connected_accounts: [expiredMeta], subscription_status: 'active' });
    jest.mocked(sendAgentModeOncallAlert).mockRejectedValueOnce(new Error('smtp down'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await runAccountHealthClassifier({ now: NOW })).alertFailed).toBe(1);
    await runAccountHealthClassifier({ now: NOW + DAY_MS });
    expect(sendAgentModeOncallAlert).toHaveBeenCalledTimes(2);
    expect(jest.mocked(sendAgentModeOncallAlert).mock.calls[1][0].context).toMatchObject({ reason: 'retry' });
  });

  it('skips sandbox principals and treats an unreadable payment history as a gap, not a risk', async () => {
    users.push({ userId: 'eval_sandbox', connected_accounts: [expiredMeta], subscription_status: 'active' });
    users.push({ userId: 'u3', connected_accounts: [liveMeta], subscription_status: 'active' });
    jest.mocked(paymentHistoryDb.getByUserId).mockRejectedValue(new Error('throttled'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const summary = await runAccountHealthClassifier({ now: NOW });
    expect(summary.scanned).toBe(1);
    expect(summary.byState.insufficient_evidence).toBe(1);
    expect(sendAgentModeOncallAlert).not.toHaveBeenCalled();
  });
});
