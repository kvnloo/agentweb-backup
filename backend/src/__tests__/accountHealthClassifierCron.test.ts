/**
 * ENG-2143: routing and dedupe of account-health signals. Covers ENG-2016 AC3 (once per account +
 * billing cycle, again on a material transition), AC4 (correction suppression), AC7 (repeated
 * runs emit once; reconnect then disconnect emits a new alert), decision D6 (activation → CS,
 * never oncall), and the ACCOUNT_HEALTH_ALERTS_ENABLED gate.
 */

jest.mock('../services/db', () => ({ userDb: { scanWithFilter: jest.fn() } }));
jest.mock('../services/paymentHistoryDb', () => ({ paymentHistoryDb: { getByUserId: jest.fn() } }));
jest.mock('../services/adsMetricsDb', () => ({
  adsMetricsDb: { getAccountDaySnapshots: jest.fn(), getSnapshotsByUserDateRange: jest.fn() },
}));
jest.mock('../utils/agentModeAlerts', () => ({ sendAgentModeOncallAlert: jest.fn() }));
jest.mock('../services/emailService', () => ({
  emailService: { sendEmail: jest.fn(), escapeHtml: (value: string) => value },
}));
jest.mock('../services/settingsService', () => ({ settingsService: { getJsonArraySetting: jest.fn() } }));
jest.mock('../services/accountCapabilityRequirementsDb', () => ({
  getAccountCapabilityRequirement: jest.fn(),
  getAccountHealthSignalState: jest.fn(),
  putAccountHealthSignalState: jest.fn(),
  isSuppressed: jest.fn(),
}));
jest.mock('../loops/eval/evalRegistry', () => ({ mayGate: jest.fn() }));
jest.mock('../utils/instanceState', () => ({ isCronEnabled: jest.fn() }));
jest.mock('../services/chatbotService', () => ({ chatbotDb: { getRecentSessionFeedback: jest.fn() } }));
jest.mock('../services/metaTrackingMonitor', () => ({ monitorUserTracking: jest.fn() }));
jest.mock('../services/googleAdsService', () => ({ googleAdsService: { getCampaignDelivery: jest.fn() } }));

import { userDb } from '../services/db';
import { paymentHistoryDb, type PaymentHistoryRecord } from '../services/paymentHistoryDb';
import { adsMetricsDb } from '../services/adsMetricsDb';
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';
import { emailService } from '../services/emailService';
import { settingsService } from '../services/settingsService';
import {
  getAccountCapabilityRequirement,
  getAccountHealthSignalState,
  putAccountHealthSignalState,
  isSuppressed,
  type AccountCapabilityRequirement,
  type AccountHealthSignalState,
} from '../services/accountCapabilityRequirementsDb';
import {
  CS_NUDGE_PENDING_TIMEOUT_MS,
  decideAccountHealthSignal,
  gatherAccountHealthSignals,
  runAccountHealthClassifier,
  type AccountHealthUser,
} from '../cron/accountHealthClassifierCron';
import { classifyAccountHealth, type AccountHealthSignals } from '../services/accountHealthClassifier';
import { mayGate } from '../loops/eval/evalRegistry';
import { isCronEnabled } from '../utils/instanceState';
import { chatbotDb } from '../services/chatbotService';
import { monitorUserTracking, type MonitorSummary } from '../services/metaTrackingMonitor';
import type { AdsMetricsSnapshotRow } from '../services/adsMetricsDb';
import { googleAdsService } from '../services/googleAdsService';

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

/**
 * Runs `decide` over a sequence of classifications, persisting `next` like the cron does. A
 * claimed cs_nudge is auto-finalized to `delivered` before the next step, matching a normal run
 * where the digest send (and its finalize) follows the claim in the same process — this helper is
 * for dedup/routing semantics, not delivery-recovery, which the `cs_nudge delivery recovery`
 * describe block below covers with an explicit unfinalized (still-`pending`) claim.
 */
function replay(results: Array<{ at: number; overrides?: Partial<AccountHealthSignals> }>) {
  let state: AccountHealthSignalState | null = null;
  return results.map(({ at, overrides }) => {
    const decision = decideAccountHealthSignal(state, classify(overrides, at), iso(at), { oncallAllowed: true });
    if (decision.next) {
      state = decision.next.csNudgeDeliveryStatus === 'pending'
        ? { ...decision.next, csNudgeDeliveryStatus: 'delivered' }
        : decision.next;
    }
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

  // CodeRabbit #3128: the claim (`putAccountHealthSignalState`, in the per-user loop) was
  // persisted well before the batched digest email was even attempted (after the whole scan
  // loop). A process stop in between (crash, deploy, OOM) left the claim looking "already
  // handled" forever, with no way to recover it — the nudge was silently lost.
  describe('cs_nudge delivery recovery', () => {
    // billingCycle here is '2026-10-10' (the date portion of classify()'s default currentPeriodEnd),
    // not a month fallback — matches what activation() below actually recomputes.
    const pendingClaim = (claimedAt: number, overrides: Partial<AccountHealthSignalState> = {}): AccountHealthSignalState => ({
      state: 'activation_incomplete',
      stateSince: iso(claimedAt),
      lastEpisodeKey: `activation_incomplete|2026-10-10|${iso(claimedAt)}`,
      lastSignalCodes: ['ads_never_connected'],
      lastSignalAt: iso(claimedAt),
      lastSignalChannel: 'cs_nudge',
      csNudgeDeliveryStatus: 'pending',
      version: 1,
      ...overrides,
    });
    const activation = () => classify({ connectedAccounts: [] }, NOW);

    it('recovers a claim left pending past the timeout, as a retry (the process never reached the digest send)', () => {
      const claimedAt = NOW - CS_NUDGE_PENDING_TIMEOUT_MS - 1;
      const decision = decideAccountHealthSignal(pendingClaim(claimedAt), activation(), iso(NOW));
      expect(decision).toMatchObject({ channel: 'cs_nudge', emit: true, reason: 'retry' });
      expect(decision.next).toMatchObject({ state: 'activation_incomplete', csNudgeDeliveryStatus: 'pending', version: 2 });
    });

    it('does not recover a pending claim still inside the timeout window (a run genuinely in flight)', () => {
      const claimedAt = NOW - CS_NUDGE_PENDING_TIMEOUT_MS + 1000;
      const decision = decideAccountHealthSignal(pendingClaim(claimedAt), activation(), iso(NOW));
      expect(decision).toMatchObject({ emit: false, reason: 'unchanged', next: null });
    });

    it('never re-sends a claim already confirmed delivered, however old', () => {
      const claimedAt = NOW - 10 * CS_NUDGE_PENDING_TIMEOUT_MS;
      const decision = decideAccountHealthSignal(
        pendingClaim(claimedAt, { csNudgeDeliveryStatus: 'delivered' }),
        activation(),
        iso(NOW),
      );
      expect(decision).toMatchObject({ emit: false, reason: 'unchanged', next: null });
    });
  });
});

function monitorSummary(overrides: Partial<MonitorSummary>): MonitorSummary {
  return {
    accountsChecked: 0, blackouts: 0, tokenErrors: 0, fetchErrors: 0, unclassifiable: 0, idle: 0, healthy: 0,
    unrecognizedActionTypes: [], excludedObjectives: [], unknownObjectives: [], optimisationAlerts: 0,
    optimisationDormant: 0, optimisationUnconfirmed: 0, optimisationStaleDelivery: 0, optimisationUnconfirmable: 0,
    landingPageAlerts: 0, landingPageUnverifiable: 0, landingPageOk: 0, landingPageDeferred: 0,
    landingPageUnconfirmed: 0, landingPageFindings: [], destinationAlerts: 0, destinationUnverifiable: 0,
    destinationOk: 0, destinationUnconfirmed: 0, duplicateAccountsSkipped: 0, eventMixRegressions: 0,
    eventMixWatched: 0, eventMixStale: 0,
    ...overrides,
  };
}

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
    jest.mocked(settingsService.getJsonArraySetting).mockResolvedValue(['cs@example.com']);
    jest.mocked(emailService.sendEmail).mockResolvedValue('sent');
    jest.mocked(mayGate).mockReturnValue(true);
    jest.mocked(isCronEnabled).mockReturnValue(true);
    jest.mocked(adsMetricsDb.getSnapshotsByUserDateRange).mockResolvedValue({ rows: [], truncated: false });
    jest.mocked(chatbotDb.getRecentSessionFeedback).mockResolvedValue([]);
    jest.mocked(monitorUserTracking).mockResolvedValue(monitorSummary({ accountsChecked: 1 }));
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

  it('never pages oncall for a never-connected account: it goes to the CS nudge', async () => {
    users.push({ userId: 'u2', connected_accounts: [], subscription_status: 'active' });
    const summary = await runAccountHealthClassifier({ now: NOW });
    expect(summary).toMatchObject({ csNudges: 1, oncall: 0 });
    expect(sendAgentModeOncallAlert).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('cs_nudge {"userId":"u2","state":"activation_incomplete"'));
  });

  // ENG-2188: the nudge used to be a console.info line nobody acted on.
  it('ENG-2188: sends one actionable CS digest email per run for every new activation nudge, once per episode', async () => {
    users.push({ userId: 'u2', email: 'two@example.com', connected_accounts: [], subscription_status: 'active' });
    users.push({ userId: 'u3', email: 'three@example.com', connected_accounts: [], subscription_status: 'active' });
    const summary = await runAccountHealthClassifier({ now: NOW });
    expect(summary).toMatchObject({ csNudges: 2, csNudgeUndelivered: 0, oncall: 0 });
    expect(settingsService.getJsonArraySetting).toHaveBeenCalledWith('account_health_cs_emails', []);
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    const [to, subject, text] = jest.mocked(emailService.sendEmail).mock.calls[0];
    expect(to).toEqual(['cs@example.com']);
    expect(subject).toBe('Activation nudges: 2 paying account(s) have not connected an ad account');
    expect(text).toContain('not churn risk');
    expect(text).toContain('- two@example.com: no ad account connected yet (ads are a current requirement: urgent)');
    expect(text).toContain('- three@example.com: no ad account connected yet');
    expect(store.get('u2')?.lastSignalChannel).toBe('cs_nudge');

    expect(await runAccountHealthClassifier({ now: NOW + DAY_MS })).toMatchObject({ csNudges: 0 });
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('ENG-2188: with no CS recipients configured the nudge is undelivered and retried, never dropped', async () => {
    users.push({ userId: 'u2', connected_accounts: [], subscription_status: 'active' });
    jest.mocked(settingsService.getJsonArraySetting).mockResolvedValueOnce([]);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await runAccountHealthClassifier({ now: NOW })).toMatchObject({ csNudges: 0, csNudgeUndelivered: 1 });
    expect(emailService.sendEmail).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('account_health_cs_emails is not set'));

    expect(await runAccountHealthClassifier({ now: NOW + DAY_MS })).toMatchObject({ csNudges: 1 });
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('ENG-2188: a failed CS digest send releases the claims so the next run retries', async () => {
    users.push({ userId: 'u2', connected_accounts: [], subscription_status: 'active' });
    jest.mocked(emailService.sendEmail).mockResolvedValueOnce('failed');
    expect(await runAccountHealthClassifier({ now: NOW })).toMatchObject({ csNudgeUndelivered: 1 });
    expect(await runAccountHealthClassifier({ now: NOW + DAY_MS })).toMatchObject({ csNudges: 1 });
    expect(emailService.sendEmail).toHaveBeenCalledTimes(2);
  });

  // CodeRabbit #3128: the claim used to be persisted (and count as "handled") well before the
  // batched digest was even attempted. Simulates the gap a process stop leaves behind — a claim
  // durably written by a run that never reached the send — by seeding the store directly, the way
  // a crashed prior process would have left it, rather than going through a live run.
  it('ENG-2188 CodeRabbit: recovers a CS nudge whose process stopped between the claim and the digest send', async () => {
    users.push({ userId: 'u2', email: 'two@example.com', connected_accounts: [], subscription_status: 'active' });
    const claimedAt = NOW - CS_NUDGE_PENDING_TIMEOUT_MS - 1;
    store.set('u2', {
      state: 'activation_incomplete',
      stateSince: iso(claimedAt),
      lastEpisodeKey: `activation_incomplete|month:2026-08|${iso(claimedAt)}`,
      lastSignalCodes: ['ads_never_connected'],
      lastSignalAt: iso(claimedAt),
      lastSignalChannel: 'cs_nudge',
      csNudgeDeliveryStatus: 'pending',
      version: 1,
    });

    const summary = await runAccountHealthClassifier({ now: NOW });

    expect(summary).toMatchObject({ csNudges: 1, csNudgeUndelivered: 0 });
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    expect(jest.mocked(emailService.sendEmail).mock.calls[0][2]).toContain('two@example.com');
    // version 3: 1 (seeded) -> 2 (this run's claim) -> 3 (finalized once the digest sent).
    expect(store.get('u2')).toMatchObject({ csNudgeDeliveryStatus: 'delivered', version: 3 });

    // Recovered and delivered: a later run must not recover or resend it again.
    expect(await runAccountHealthClassifier({ now: NOW + 3 * CS_NUDGE_PENDING_TIMEOUT_MS })).toMatchObject({ csNudges: 0 });
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('ENG-2188 CodeRabbit: a pending claim inside the recovery timeout is left alone (a run genuinely still in flight)', async () => {
    users.push({ userId: 'u2', connected_accounts: [], subscription_status: 'active' });
    const claimedAt = NOW - CS_NUDGE_PENDING_TIMEOUT_MS + 1000;
    // Same month as NOW (no current_period_end on this user, so billingCycleKey falls back to
    // the current UTC month): this must be the episode the live classification would recompute,
    // so the claim reads as truly unchanged rather than accidentally as a new billing cycle.
    store.set('u2', {
      state: 'activation_incomplete',
      stateSince: iso(claimedAt),
      lastEpisodeKey: `activation_incomplete|month:2026-09|${iso(claimedAt)}`,
      lastSignalCodes: ['ads_never_connected'],
      lastSignalAt: iso(claimedAt),
      lastSignalChannel: 'cs_nudge',
      csNudgeDeliveryStatus: 'pending',
      version: 1,
    });

    const summary = await runAccountHealthClassifier({ now: NOW });

    expect(summary).toMatchObject({ csNudges: 0, csNudgeUndelivered: 0, silent: 1 });
    expect(emailService.sendEmail).not.toHaveBeenCalled();
    expect(store.get('u2')).toMatchObject({ csNudgeDeliveryStatus: 'pending', version: 1 });
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

describe('gatherAccountHealthSignals: behavioural inputs (ENG-2143 audit)', () => {
  const campaignRow = (date: string, spend: number) => ({ date, spend, rowType: 'campaign' }) as unknown as AdsMetricsSnapshotRow;
  const accountDayRow = (date: string) => ({ date, spend: 0, totalLeadCount: 0, rowType: 'account_day' }) as unknown as AdsMetricsSnapshotRow;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.mocked(getAccountCapabilityRequirement).mockResolvedValue(null);
    jest.mocked(paymentHistoryDb.getByUserId).mockResolvedValue([]);
    jest.mocked(chatbotDb.getRecentSessionFeedback).mockResolvedValue([]);
    jest.mocked(monitorUserTracking).mockResolvedValue(monitorSummary({ accountsChecked: 1 }));
  });

  // Account-day rows always store spend 0 (metaMetricsSnapshotCron), so reading spend from them
  // made "ad spend in the last 30 days" permanently zero.
  it('reads recent ad spend from campaign rows, so real spend makes the ads requirement current', async () => {
    jest.mocked(adsMetricsDb.getAccountDaySnapshots).mockResolvedValue({ rows: [accountDayRow('2026-09-20')], truncated: false });
    jest.mocked(adsMetricsDb.getSnapshotsByUserDateRange).mockResolvedValue({ rows: [campaignRow('2026-09-20', 120)], truncated: false });
    const { signals } = await gatherAccountHealthSignals({ userId: 'u1', connected_accounts: [expiredMeta] }, NOW);
    expect(signals.recentAdSpend).toBe(120);
    expect(signals.adDays).toEqual([{ date: '2026-09-20', spend: 120, leads: 0 }]);
    expect(classifyAccountHealth(signals)).toMatchObject({ state: 'at_risk', requirement: 'required' });
  });

  it('a truncated metrics read is unread (null), never a zero', async () => {
    jest.mocked(adsMetricsDb.getAccountDaySnapshots).mockResolvedValue({ rows: [], truncated: false });
    jest.mocked(adsMetricsDb.getSnapshotsByUserDateRange).mockResolvedValue({ rows: [], truncated: true });
    const { signals } = await gatherAccountHealthSignals({ userId: 'u1', connected_accounts: [liveMeta] }, NOW);
    expect(signals).toMatchObject({ adDays: null, recentAdSpend: null });
  });

  it('reads ratings from the last 30 days and runs the tracking monitor capture-only for Meta accounts', async () => {
    jest.mocked(adsMetricsDb.getAccountDaySnapshots).mockResolvedValue({ rows: [], truncated: false });
    jest.mocked(adsMetricsDb.getSnapshotsByUserDateRange).mockResolvedValue({ rows: [], truncated: false });
    jest.mocked(monitorUserTracking).mockResolvedValue(monitorSummary({ accountsChecked: 1, destinationAlerts: 2, landingPageAlerts: 1 }));
    const user = { userId: 'u1', connected_accounts: [liveMeta] };
    const { signals } = await gatherAccountHealthSignals(user, NOW);
    expect(chatbotDb.getRecentSessionFeedback).toHaveBeenCalledWith('u1', iso(NOW - 30 * DAY_MS));
    expect(monitorUserTracking).toHaveBeenCalledWith(user, { dryRun: true });
    expect(signals.tracking).toEqual({ destinationsWithoutOwnedPixel: 2, landingPagesWithoutOwnedPixel: 1 });
    expect(classifyAccountHealth(signals).state).toBe('activation_incomplete');
  });

  it('never runs the tracking monitor without a Meta ad account, and a failed check is unread', async () => {
    jest.mocked(adsMetricsDb.getAccountDaySnapshots).mockResolvedValue({ rows: [], truncated: false });
    jest.mocked(adsMetricsDb.getSnapshotsByUserDateRange).mockResolvedValue({ rows: [], truncated: false });
    expect((await gatherAccountHealthSignals({ userId: 'u1', connected_accounts: [] }, NOW)).signals.tracking).toBeNull();
    expect(monitorUserTracking).not.toHaveBeenCalled();
    jest.mocked(monitorUserTracking).mockRejectedValueOnce(new Error('graph down'));
    expect((await gatherAccountHealthSignals({ userId: 'u1', connected_accounts: [liveMeta] }, NOW)).signals.tracking).toBeNull();
  });
});

describe('gatherAccountHealthSignals: live Google Ads campaign delivery (ENG-1913)', () => {
  const liveGoogle = { platform: 'google_ads', account_id: '1234567890', config: { token_expires_at: NOW + 30 * DAY_MS } };
  const campaign = (id: string, over: Record<string, unknown> = {}) => ({
    campaignId: id, status: 'ENABLED', approvedDailyBudget: 33, liveSince: iso(NOW - 7 * DAY_MS), impressions: 0, clicks: 0, ...over,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.mocked(getAccountCapabilityRequirement).mockResolvedValue(null);
    jest.mocked(paymentHistoryDb.getByUserId).mockResolvedValue([]);
    jest.mocked(chatbotDb.getRecentSessionFeedback).mockResolvedValue([]);
    jest.mocked(adsMetricsDb.getAccountDaySnapshots).mockResolvedValue({ rows: [], truncated: false });
    jest.mocked(adsMetricsDb.getSnapshotsByUserDateRange).mockResolvedValue({ rows: [], truncated: false });
  });

  // AC5: Smart Water Heater — three enabled Search campaigns, $100/day combined, 7 days of zero delivery.
  it('feeds the SWH zero-delivery replay into the classifier and flags it at_risk', async () => {
    jest.mocked(googleAdsService.getCampaignDelivery).mockResolvedValue([
      campaign('core'), campaign('competitor'), campaign('exact', { approvedDailyBudget: 34 }),
    ]);
    const { signals } = await gatherAccountHealthSignals({ userId: 'swh', connected_accounts: [liveGoogle] }, NOW);
    expect(googleAdsService.getCampaignDelivery).toHaveBeenCalledWith('swh', '1234567890', NOW);
    expect(signals.campaigns).toHaveLength(3);
    const result = classifyAccountHealth({ ...signals, requirement: { requirementSource: 'contracted' } } as AccountHealthSignals);
    expect(result.state).toBe('at_risk');
    expect(JSON.stringify(result)).toContain('zero_delivery');
  });

  it('does not flag delivering, paused, or warming-up campaigns (AC2-AC4)', async () => {
    jest.mocked(googleAdsService.getCampaignDelivery).mockResolvedValue([
      campaign('delivering', { impressions: 900, clicks: 12 }),
      campaign('paused', { status: 'PAUSED' }),
      campaign('new', { liveSince: iso(NOW - 2 * 60 * 60 * 1000) }),
    ]);
    const { signals } = await gatherAccountHealthSignals({ userId: 'u1', connected_accounts: [liveGoogle] }, NOW);
    const result = classifyAccountHealth({ ...signals, requirement: { requirementSource: 'contracted' } } as AccountHealthSignals);
    expect(JSON.stringify(result)).not.toContain('zero_delivery');
  });

  it('a failed Google read is unread (null), never zero delivery', async () => {
    jest.mocked(googleAdsService.getCampaignDelivery).mockRejectedValue(new Error('quota'));
    const { signals } = await gatherAccountHealthSignals({ userId: 'u1', connected_accounts: [liveGoogle] }, NOW);
    expect(signals.campaigns).toBeNull();
  });

  it('accounts without Google Ads stay unread and never call Google', async () => {
    const { signals } = await gatherAccountHealthSignals({ userId: 'u1', connected_accounts: [liveMeta] }, NOW);
    expect(signals.campaigns).toBeNull();
    expect(googleAdsService.getCampaignDelivery).not.toHaveBeenCalled();
  });

  it('regression: a non-Google account still classifies with delivery_not_read and no zero_delivery', async () => {
    const { signals } = await gatherAccountHealthSignals({ userId: 'u1', connected_accounts: [liveMeta] }, NOW);
    const result = classifyAccountHealth({ ...signals, requirement: { requirementSource: 'contracted' } } as AccountHealthSignals);
    expect(result.evidence.find((e) => e.code === 'delivery_not_read')?.kind).toBe('gap');
    expect(JSON.stringify(result)).not.toContain('zero_delivery');
  });

  it('an ENDED campaign is excluded, not stuck', async () => {
    jest.mocked(googleAdsService.getCampaignDelivery).mockResolvedValue([campaign('done', { status: 'ENDED' })]);
    const { signals } = await gatherAccountHealthSignals({ userId: 'u1', connected_accounts: [liveGoogle] }, NOW);
    const result = classifyAccountHealth({ ...signals, requirement: { requirementSource: 'contracted' } } as AccountHealthSignals);
    expect(JSON.stringify(result)).not.toContain('zero_delivery');
  });

  it('one failing Google account leaves the whole user unread, never a verdict from the others', async () => {
    const second = { ...liveGoogle, account_id: '999' };
    jest.mocked(googleAdsService.getCampaignDelivery).mockImplementation(async (_u: string, id: string) => {
      if (id === '999') throw new Error('429');
      return [campaign('stuck')] as any;
    });
    const { signals } = await gatherAccountHealthSignals({ userId: 'u1', connected_accounts: [liveGoogle, second] }, NOW);
    expect(signals.campaigns).toBeNull();
  });
});
