/**
 * Account-health sweep (ENG-2143). Replaces two paths that could not be trusted:
 *  - `renewalIntegrationHealthCron` (off in prod): alerted "Renewal at risk" from stale onboarding
 *    intent, including accounts that never connected an ad account, re-alerting every 24h.
 *  - the ENG-1342 account-health block in `metaTrackingMonitorCron`: `console.warn` only.
 *
 * Every paying account is classified by `accountHealthClassifier`; the result is routed by state:
 *  - `at_risk` → the oncall alert path once the classifier has a qualifying validation in the
 *    eval registry (`mayGate`); until then a needs-review log line. At most once per account + billing cycle + episode, again
 *    only when new risk evidence appears (ENG-2016 AC3). A human correction on the account's
 *    capability row still suppresses a connection/delivery-only alert (ENG-2016 AC4).
 *  - `activation_incomplete` → a CS nudge log line. Never oncall, never churn (decision D6).
 *  - `insufficient_evidence` → a needs-review log line (ENG-2016 AC2).
 *  - `healthy` → nothing.
 *
 * Dedupe state lives in AW-AccountCapabilityRequirements under its own range key and is claimed
 * with a version check before anything is emitted: every instance runs this cron, and an
 * in-memory window would re-alert after each deploy.
 *
 * Inert until ACCOUNT_HEALTH_ALERTS_ENABLED=true (OPS). With the flag unset, server.ts never
 * schedules it and a direct non-dry run refuses to write or send.
 */

import { userDb } from '../services/db';
import { paymentHistoryDb } from '../services/paymentHistoryDb';
import { adsMetricsDb } from '../services/adsMetricsDb';
import { isEvaluationUser } from '../services/evaluationPolicy';
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';
import {
  getAccountCapabilityRequirement,
  getAccountHealthSignalState,
  putAccountHealthSignalState,
  isSuppressed,
  type AccountCapabilityRequirement,
  type AccountHealthSignalState,
} from '../services/accountCapabilityRequirementsDb';
import {
  classifyAccountHealth,
  type AccountHealthClassification,
  type AccountHealthSignals,
  type EvidenceCode,
} from '../services/accountHealthClassifier';
import type { AdConnectionAccount } from '../services/clientHealthService';
import { mayGate } from '../loops/eval/evalRegistry';

const TAG = '[accountHealthClassifierCron]';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Subscription states that are still paying (or trying to). Canceled accounts have already churned. */
const PAYING_STATUSES = ['active', 'past_due', 'canceling'];

export function isAccountHealthAlertsEnabled(): boolean {
  return process.env.ACCOUNT_HEALTH_ALERTS_ENABLED === 'true';
}

export type AccountHealthChannel = 'oncall' | 'cs_nudge' | 'needs_review' | 'none';
/**
 * `retry`: same episode, but its signal was never delivered (the last send failed).
 * `escalated`: same episode and evidence, but it was last signalled below oncall (a correction
 * that has since lapsed) and now routes to oncall.
 */
export type AccountHealthSignalReason =
  | 'new_episode'
  | 'new_billing_cycle'
  | 'new_evidence'
  | 'escalated'
  | 'retry'
  | 'unchanged';

export interface AccountHealthSignalDecision {
  channel: AccountHealthChannel;
  emit: boolean;
  reason: AccountHealthSignalReason;
  /** The evidence codes this signal is about (risk, activation or gap codes). */
  codes: EvidenceCode[];
  /** State to persist, or null when nothing changed. */
  next: AccountHealthSignalState | null;
}

/** Only connection/delivery risks are about the ad capability a human correction covers. */
const CORRECTABLE_RISKS: ReadonlySet<EvidenceCode> = new Set(['ads_connection_expired', 'zero_delivery']);

/** The registry id whose validation decides whether at-risk may page oncall (ENG-2128 principle 2). */
export const ACCOUNT_HEALTH_GRADER_ID = 'account-health-classifier';

function channelFor(result: AccountHealthClassification, correctionActive: boolean, oncallAllowed: boolean): AccountHealthChannel {
  switch (result.state) {
    case 'at_risk': {
      const risks = result.evidence.filter((e) => e.kind === 'risk').map((e) => e.code);
      if (correctionActive && risks.every((c) => CORRECTABLE_RISKS.has(c))) return 'needs_review';
      return oncallAllowed ? 'oncall' : 'needs_review';
    }
    case 'activation_incomplete':
      return 'cs_nudge';
    case 'insufficient_evidence':
      return 'needs_review';
    case 'healthy':
      return 'none';
  }
}

/**
 * The dedupe rule, pure. A signal is emitted once per episode (a continuous stretch in one state)
 * and billing cycle, and again inside it only when a new evidence code appears. Leaving the state
 * and coming back (reconnect, then disconnect) starts a new episode, so it alerts again.
 */
export function decideAccountHealthSignal(
  prev: AccountHealthSignalState | null,
  result: AccountHealthClassification,
  nowIso: string,
  opts: { correctionActive?: boolean; oncallAllowed?: boolean } = {},
): AccountHealthSignalDecision {
  const channel = channelFor(result, opts.correctionActive ?? false, opts.oncallAllowed ?? false);
  const codes = result.evidence
    .filter((e) => e.kind === 'risk' || e.kind === 'activation' || e.kind === 'gap')
    .map((e) => e.code)
    .sort();
  // "Could not tell" (typically one failed read) is not a transition: it must not end an open
  // at-risk or activation episode, or the next good read would re-alert as a new episode.
  if (result.state === 'insufficient_evidence' && (prev?.state === 'at_risk' || prev?.state === 'activation_incomplete')) {
    return { channel, emit: false, reason: 'unchanged', codes, next: null };
  }
  const sameState = prev?.state === result.state;
  const stateSince = sameState && prev ? prev.stateSince : nowIso;
  const episodeKey = `${result.state}|${result.billingCycle}|${stateSince}`;
  const priorCodes = prev?.lastEpisodeKey === episodeKey ? (prev.lastSignalCodes ?? []) : [];

  let reason: AccountHealthSignalReason;
  if (!sameState) reason = 'new_episode';
  else if (!prev?.lastEpisodeKey) reason = 'retry';
  else if (prev.lastEpisodeKey !== episodeKey) reason = 'new_billing_cycle';
  else if (codes.some((c) => !priorCodes.includes(c))) reason = 'new_evidence';
  else if (channel === 'oncall' && prev.lastSignalChannel !== 'oncall') reason = 'escalated';
  else reason = 'unchanged';

  const emit = channel !== 'none' && reason !== 'unchanged';
  if (!emit && sameState) return { channel, emit, reason, codes, next: null };
  const version = (prev?.version ?? 0) + 1;
  const next: AccountHealthSignalState = emit
    ? {
        state: result.state,
        stateSince,
        lastEpisodeKey: episodeKey,
        lastSignalCodes: [...new Set([...priorCodes, ...codes])].sort(),
        lastSignalAt: nowIso,
        lastSignalChannel: channel,
        version,
      }
    : { state: result.state, stateSince, version };
  return { channel, emit, reason, codes, next };
}

/** The AW-Users fields this sweep reads. */
export interface AccountHealthUser {
  userId: string;
  email?: string;
  connected_accounts?: ReadonlyArray<AdConnectionAccount | null | undefined>;
  adAccount?: string;
  subscription_status?: string;
  current_period_end?: string;
  lastActiveAt?: string;
}

export interface GatheredAccountHealth {
  signals: AccountHealthSignals;
  capabilityRow: AccountCapabilityRequirement | null;
}

/**
 * 30-day ad spend from Meta account-day snapshots. null when unread or truncated, never a fake zero.
 * Summed across account currencies, so it only answers "was anything spent" (> 0), not how much.
 */
async function readRecentAdSpend(userId: string, nowMs: number): Promise<number | null> {
  try {
    const since = new Date(nowMs - 30 * DAY_MS).toISOString().slice(0, 10);
    const until = new Date(nowMs).toISOString().slice(0, 10);
    const result = await adsMetricsDb.getAccountDaySnapshots(userId, since, until);
    if (result.truncated) return null;
    return result.rows.reduce((sum, row) => sum + (Number.isFinite(row.spend) ? row.spend : 0), 0);
  } catch (error) {
    console.error(`${TAG} ad spend read failed for user ${userId}:`, error);
    return null;
  }
}

/**
 * Reads every signal for one account. A failed read becomes null (unknown), which the classifier
 * reports as a gap rather than as evidence either way.
 */
export async function gatherAccountHealthSignals(user: AccountHealthUser, nowMs: number): Promise<GatheredAccountHealth> {
  const [capabilityRow, payments, recentAdSpend] = await Promise.all([
    getAccountCapabilityRequirement(user.userId, 'ad_platform_integration').catch((error: unknown) => {
      console.error(`${TAG} capability read failed for user ${user.userId}:`, error);
      return null;
    }),
    paymentHistoryDb.getByUserId(user.userId).catch((error: unknown) => {
      console.error(`${TAG} payment history read failed for user ${user.userId}:`, error);
      return null;
    }),
    readRecentAdSpend(user.userId, nowMs),
  ]);
  return {
    capabilityRow,
    signals: {
      nowMs,
      connectedAccounts: user.connected_accounts,
      legacyAdAccount: user.adAccount,
      requirement: capabilityRow,
      subscriptionStatus: user.subscription_status,
      currentPeriodEnd: user.current_period_end,
      payments,
      // No stored per-campaign status/budget exists yet (AW-AdsMetricsSnapshots only records
      // campaigns that delivered), so the ENG-1913 zero-delivery check has no live input here.
      campaigns: null,
      recentAdSpend,
      lastActiveAt: user.lastActiveAt,
    },
  };
}

const NEXT_ACTOR: Partial<Record<EvidenceCode, string>> = {
  payment_failed: 'CS / billing: contact the customer about the failed payment',
  subscription_past_due: 'CS / billing: contact the customer about the past-due subscription',
  zero_delivery: 'Ads operator: inspect the stuck campaigns (paused keywords/ad sets, disapprovals)',
  ads_connection_expired: 'Customer: reconnect the ad account in Settings > Connected Accounts; CS to prompt',
};

function formatAlert(user: AccountHealthUser, result: AccountHealthClassification, decision: AccountHealthSignalDecision, prev: AccountHealthSignalState | null) {
  const who = user.email || user.userId;
  const risks = result.evidence.filter((e) => e.kind === 'risk');
  const nextActor = risks.map((e) => NEXT_ACTOR[e.code]).filter(Boolean).join('; ');
  const previous = prev ? `${prev.state} since ${prev.stateSince}` : 'no earlier classification on record';
  const message =
    `${who} is at risk (${result.confidence} confidence).\n\n` +
    `Risk evidence:\n${risks.map((e) => `- ${e.detail}`).join('\n')}\n\n` +
    `Current ads requirement: ${result.requirement}\n` +
    `Previous state: ${previous}\n` +
    `Why now: ${decision.reason}\n` +
    `Billing cycle: ${result.billingCycle}\n` +
    `Next actor: ${nextActor}\n\n` +
    `All evidence:\n${result.evidence.map((e) => `- [${e.kind}] ${e.code}: ${e.detail}`).join('\n')}`;
  return {
    subject: `Account health: ${who} is at risk`,
    message,
    context: {
      // One open tracked issue per account: later occurrences land on it as comments.
      'Alert Class': `account-health:${user.userId}`,
      userId: user.userId,
      state: result.state,
      confidence: result.confidence,
      codes: decision.codes,
      billingCycle: result.billingCycle,
      reason: decision.reason,
      nextActor,
    },
  };
}

export interface AccountHealthSweepSummary {
  scanned: number;
  byState: Record<AccountHealthClassification['state'], number>;
  oncall: number;
  csNudges: number;
  needsReview: number;
  /** Classified but nothing to emit (healthy, or already signalled this episode). */
  silent: number;
  /** Another instance claimed the same signal first. */
  lostRace: number;
  alertFailed: number;
  evaluationFailed: number;
  /** Dry runs only: what would have been emitted. */
  captured?: Array<{ userId: string; state: string; channel: AccountHealthChannel; reason: AccountHealthSignalReason; codes: EvidenceCode[] }>;
}

export async function runAccountHealthClassifier(
  opts: { dryRun?: boolean; now?: number } = {},
): Promise<AccountHealthSweepSummary> {
  const summary: AccountHealthSweepSummary = {
    scanned: 0,
    byState: { activation_incomplete: 0, at_risk: 0, healthy: 0, insufficient_evidence: 0 },
    oncall: 0,
    csNudges: 0,
    needsReview: 0,
    silent: 0,
    lostRace: 0,
    alertFailed: 0,
    evaluationFailed: 0,
  };
  const dryRun = opts.dryRun ?? false;
  if (!dryRun && !isAccountHealthAlertsEnabled()) {
    console.log(`${TAG} ACCOUNT_HEALTH_ALERTS_ENABLED is not 'true'; refusing a live run`);
    return summary;
  }
  if (dryRun) summary.captured = [];
  const nowMs = opts.now ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  // Unvalidated graders cannot alert: until a qualifying validation is recorded in the eval
  // registry, at_risk is a needs-review log line. Once it is, the stored needs_review signal
  // escalates to oncall on the next run.
  const oncallAllowed = mayGate(ACCOUNT_HEALTH_GRADER_ID);

  let users: AccountHealthUser[];
  try {
    users = (await userDb.scanWithFilter('subscription_status IN (:s0, :s1, :s2)', {
      ':s0': PAYING_STATUSES[0],
      ':s1': PAYING_STATUSES[1],
      ':s2': PAYING_STATUSES[2],
    })) as AccountHealthUser[];
  } catch (error) {
    console.error(`${TAG} failed to scan paying users:`, error);
    return summary;
  }

  for (const user of users) {
    if (!user?.userId || isEvaluationUser(user.userId)) continue;
    summary.scanned++;
    try {
      const { signals, capabilityRow } = await gatherAccountHealthSignals(user, nowMs);
      const result = classifyAccountHealth(signals);
      summary.byState[result.state]++;
      const prev = await getAccountHealthSignalState(user.userId);
      const decision = decideAccountHealthSignal(prev, result, nowIso, {
        correctionActive: isSuppressed(capabilityRow, nowMs),
        oncallAllowed,
      });
      if (!decision.emit) summary.silent++;
      if (dryRun) {
        if (decision.emit) {
          summary.captured?.push({ userId: user.userId, state: result.state, channel: decision.channel, reason: decision.reason, codes: decision.codes });
        }
        continue;
      }
      if (decision.next && !(await putAccountHealthSignalState(user.userId, decision.next, prev?.version ?? null))) {
        summary.lostRace++;
        continue;
      }
      if (!decision.emit) continue;

      const logLine = JSON.stringify({ userId: user.userId, state: result.state, reason: decision.reason, codes: decision.codes, billingCycle: result.billingCycle });
      if (decision.channel === 'cs_nudge') {
        summary.csNudges++;
        console.info(`${TAG} cs_nudge ${logLine}`);
      } else if (decision.channel === 'needs_review') {
        summary.needsReview++;
        console.info(`${TAG} needs_review ${logLine}`);
      } else if (decision.channel === 'oncall' && decision.next) {
        const claimed = decision.next;
        try {
          await sendAgentModeOncallAlert({ ...formatAlert(user, result, decision, prev), userId: user.userId });
          summary.oncall++;
        } catch (error) {
          summary.alertFailed++;
          console.error(`${TAG} alert send failed for user ${user.userId}:`, error);
          // Release the claim so the next run retries instead of treating the alert as delivered.
          await putAccountHealthSignalState(
            user.userId,
            {
              ...claimed,
              lastEpisodeKey: prev?.lastEpisodeKey,
              lastSignalCodes: prev?.lastSignalCodes,
              lastSignalAt: prev?.lastSignalAt,
              lastSignalChannel: prev?.lastSignalChannel,
              version: claimed.version + 1,
            },
            claimed.version,
          ).catch((releaseError: unknown) => console.error(`${TAG} claim release failed for user ${user.userId}:`, releaseError));
        }
      }
    } catch (error) {
      summary.evaluationFailed++;
      console.error(`${TAG} failed to evaluate user ${user.userId}:`, error);
    }
  }

  console.log(
    `${TAG} ${dryRun ? '[DRY RUN] ' : ''}scanned=${summary.scanned} ` +
      `at_risk=${summary.byState.at_risk} activation_incomplete=${summary.byState.activation_incomplete} ` +
      `insufficient_evidence=${summary.byState.insufficient_evidence} healthy=${summary.byState.healthy} ` +
      `oncall=${summary.oncall} csNudges=${summary.csNudges} needsReview=${summary.needsReview} ` +
      `silent=${summary.silent} lostRace=${summary.lostRace} alertFailed=${summary.alertFailed} ` +
      `evaluationFailed=${summary.evaluationFailed}`,
  );
  return summary;
}
