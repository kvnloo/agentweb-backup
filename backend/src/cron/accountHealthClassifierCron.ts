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
 *  - `activation_incomplete` → a CS nudge: one email digest per run to the AW-Settings
 *    `account_health_cs_emails` list (ENG-2188). Never oncall, never churn (decision D6). With no
 *    list configured, or a failed send, the claims are released so the nudges are retried rather
 *    than silently dropped. Each claim is written `pending` before the digest is even attempted
 *    (claiming the episode is what stops two instances both queueing it) and finalized to
 *    `delivered` only once the digest actually sends — a claim left `pending` past
 *    `CS_NUDGE_PENDING_TIMEOUT_MS` is recovered by a later sweep instead of being lost if the
 *    process stops between the claim and the send (crash, deploy, OOM).
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
import { googleAdsService } from '../services/googleAdsService';
import type { CampaignDeliveryInput } from '../services/accountHealthClassifier';
import { isEvaluationUser } from '../services/evaluationPolicy';
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
  buildAdDays,
  classifyAccountHealth,
  type AdDayInput,
  type FeedbackInput,
  type TrackingInput,
  type AccountHealthClassification,
  type AccountHealthSignals,
  type EvidenceCode,
} from '../services/accountHealthClassifier';
import type { AdConnectionAccount } from '../services/clientHealthService';
import { mayGate } from '../loops/eval/evalRegistry';
import { isCronEnabled } from '../utils/instanceState';
import { chatbotDb } from '../services/chatbotService';
import { monitorUserTracking } from '../services/metaTrackingMonitor';

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

/** AW-Settings key (JSON array of addresses) for the CS activation-nudge digest (ENG-2188). */
export const CS_NUDGE_EMAILS_SETTING = 'account_health_cs_emails';

/**
 * How long a claimed-but-unconfirmed cs_nudge is trusted before the next sweep treats it as lost
 * and retries it (CodeRabbit #3128: a process stop between the per-user claim write and the
 * batched digest send at the end of the run otherwise loses the nudge forever, because the claim
 * already reads as "handled"). Comfortably longer than a sweep normally takes, short enough that
 * a redeploy or a retry the same day recovers it rather than waiting a full cron interval.
 */
export const CS_NUDGE_PENDING_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * True when `prev` is a cs_nudge claim that was never confirmed delivered and is older than the
 * recovery timeout. `lastSignalAt` doubles as "claimed at" here — the same field the claim write
 * below stamps with `nowIso`.
 */
function isStalePendingCsNudge(prev: AccountHealthSignalState | null, nowMs: number): boolean {
  if (!prev || prev.lastSignalChannel !== 'cs_nudge' || prev.csNudgeDeliveryStatus !== 'pending') return false;
  const claimedAt = prev.lastSignalAt ? Date.parse(prev.lastSignalAt) : NaN;
  return !Number.isFinite(claimedAt) || nowMs - claimedAt > CS_NUDGE_PENDING_TIMEOUT_MS;
}

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
  // A stale pending cs_nudge is treated exactly like a released claim (see releaseClaim): the
  // signal/episode fields are dropped, keeping only state/stateSince/version, so the decision
  // below naturally recomputes as if this account had never been signalled this episode.
  const effectivePrev = isStalePendingCsNudge(prev, Date.parse(nowIso))
    ? { state: prev!.state, stateSince: prev!.stateSince, version: prev!.version }
    : prev;

  const channel = channelFor(result, opts.correctionActive ?? false, opts.oncallAllowed ?? false);
  const codes = result.evidence
    .filter((e) => e.kind === 'risk' || e.kind === 'activation' || e.kind === 'gap')
    .map((e) => e.code)
    .sort();
  // "Could not tell" (typically one failed read) is not a transition: it must not end an open
  // at-risk or activation episode, or the next good read would re-alert as a new episode.
  if (result.state === 'insufficient_evidence' && (effectivePrev?.state === 'at_risk' || effectivePrev?.state === 'activation_incomplete')) {
    return { channel, emit: false, reason: 'unchanged', codes, next: null };
  }
  const sameState = effectivePrev?.state === result.state;
  const stateSince = sameState && effectivePrev ? effectivePrev.stateSince : nowIso;
  const episodeKey = `${result.state}|${result.billingCycle}|${stateSince}`;
  const priorCodes = effectivePrev?.lastEpisodeKey === episodeKey ? (effectivePrev.lastSignalCodes ?? []) : [];

  let reason: AccountHealthSignalReason;
  if (!sameState) reason = 'new_episode';
  else if (!effectivePrev?.lastEpisodeKey) reason = 'retry';
  else if (effectivePrev.lastEpisodeKey !== episodeKey) reason = 'new_billing_cycle';
  else if (codes.some((c) => !priorCodes.includes(c))) reason = 'new_evidence';
  else if (channel === 'oncall' && effectivePrev.lastSignalChannel !== 'oncall') reason = 'escalated';
  else reason = 'unchanged';

  const emit = channel !== 'none' && reason !== 'unchanged';
  if (!emit && sameState) return { channel, emit, reason, codes, next: null };
  const version = (effectivePrev?.version ?? 0) + 1;
  const next: AccountHealthSignalState = emit
    ? {
        state: result.state,
        stateSince,
        lastEpisodeKey: episodeKey,
        lastSignalCodes: [...new Set([...priorCodes, ...codes])].sort(),
        lastSignalAt: nowIso,
        lastSignalChannel: channel,
        // Claimed, not yet confirmed sent — see sendCsNudgeDigest / finalizeCsNudgeDelivered.
        ...(channel === 'cs_nudge' ? { csNudgeDeliveryStatus: 'pending' as const } : {}),
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
 * The last 30 days of collected ad days (Meta snapshots). null when unread or truncated, never a
 * fake zero. Spend comes from the campaign rows: account-day rows always store spend 0.
 */
async function readAdDays(userId: string, nowMs: number): Promise<AdDayInput[] | null> {
  try {
    const since = new Date(nowMs - 30 * DAY_MS).toISOString().slice(0, 10);
    const until = new Date(nowMs).toISOString().slice(0, 10);
    const [accountDays, campaigns] = await Promise.all([
      adsMetricsDb.getAccountDaySnapshots(userId, since, until),
      adsMetricsDb.getSnapshotsByUserDateRange(userId, since, until),
    ]);
    if (accountDays.truncated || campaigns.truncated) return null;
    return buildAdDays(accountDays.rows, campaigns.rows);
  } catch (error) {
    console.error(`${TAG} ad metrics read failed for user ${userId}:`, error);
    return null;
  }
}

/** Ratings on sessions active in the feedback window. null when unread or too large to read. */
async function readFeedback(userId: string, nowMs: number): Promise<FeedbackInput[] | null> {
  try {
    return await chatbotDb.getRecentSessionFeedback(userId, new Date(nowMs - 30 * DAY_MS).toISOString());
  } catch (error) {
    console.error(`${TAG} feedback read failed for user ${userId}:`, error);
    return null;
  }
}

/**
 * The Meta tracking monitor's pixel findings, run capture-only (dryRun: no alert, no suppression
 * state). Only for accounts with a Meta ad account; null when nothing could be read.
 */
async function readTracking(user: AccountHealthUser): Promise<TrackingInput | null> {
  const hasMeta = (user.connected_accounts ?? []).some((acc) => acc?.platform === 'meta' && acc.config?.account_type === 'ad_account');
  if (!hasMeta) return null;
  try {
    const summary = await monitorUserTracking(user, { dryRun: true });
    if (summary.accountsChecked === 0) return null;
    return {
      destinationsWithoutOwnedPixel: summary.destinationAlerts,
      landingPagesWithoutOwnedPixel: summary.landingPageAlerts,
    };
  } catch (error) {
    console.error(`${TAG} tracking check failed for user ${user.userId}:`, error);
    return null;
  }
}

/**
 * ENG-1913: live per-campaign delivery for every connected Google Ads account (read-only GAQL).
 * null when the user has no Google Ads account or any account read fails — unread, never zero.
 */
async function readCampaignDelivery(user: AccountHealthUser, nowMs: number): Promise<CampaignDeliveryInput[] | null> {
  const customerIds = [...new Set(
    (user.connected_accounts ?? [])
      .filter((acc: any) => acc?.platform === 'google_ads')
      .map((acc: any) => String(acc.account_id || acc.config?.customer_id || '').trim())
      .filter(Boolean),
  )];
  if (customerIds.length === 0) return null;
  try {
    const perAccount = await Promise.all(customerIds.map((id) => googleAdsService.getCampaignDelivery(user.userId, id, nowMs)));
    return perAccount.flat();
  } catch (error) {
    console.error(`${TAG} Google Ads delivery read failed for user ${user.userId}:`, error);
    return null;
  }
}

/**
 * Reads every signal for one account. A failed read becomes null (unknown), which the classifier
 * reports as a gap rather than as evidence either way.
 */
export async function gatherAccountHealthSignals(user: AccountHealthUser, nowMs: number): Promise<GatheredAccountHealth> {
  const [capabilityRow, payments, adDays, feedback, tracking, campaigns] = await Promise.all([
    getAccountCapabilityRequirement(user.userId, 'ad_platform_integration').catch((error: unknown) => {
      console.error(`${TAG} capability read failed for user ${user.userId}:`, error);
      return null;
    }),
    paymentHistoryDb.getByUserId(user.userId).catch((error: unknown) => {
      console.error(`${TAG} payment history read failed for user ${user.userId}:`, error);
      return null;
    }),
    readAdDays(user.userId, nowMs),
    readFeedback(user.userId, nowMs),
    readTracking(user),
    readCampaignDelivery(user, nowMs),
  ]);
  // Summed across account currencies, so it only answers "was anything spent" (> 0), not how much.
  const recentAdSpend = adDays ? adDays.reduce((sum, day) => sum + day.spend, 0) : null;
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
      // ENG-1913: live Google Ads read (Meta has no per-campaign delivery input yet).
      campaigns,
      recentAdSpend,
      lastActiveAt: user.lastActiveAt,
      adDays,
      feedback,
      tracking,
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

interface PendingSignal {
  user: AccountHealthUser;
  result: AccountHealthClassification;
  claimed: AccountHealthSignalState;
  prev: AccountHealthSignalState | null;
}

function formatCsNudgeLine(n: PendingSignal): string {
  const lastActive = n.result.evidence.find((e) => e.code === 'recently_active' || e.code === 'inactive' || e.code === 'activity_unknown');
  const urgency = n.result.requirement === 'required' ? ' (ads are a current requirement: urgent)' : '';
  return `${n.user.email || n.user.userId}: no ad account connected yet${urgency}; ${lastActive?.detail ?? 'activity unknown'}; billing cycle ${n.result.billingCycle}`;
}

/**
 * One email per run with every new activation nudge, so a first run over a backlog is one message,
 * not one per account. Returns false when nothing was delivered (no recipients, or the send failed).
 */
async function sendCsNudgeDigest(nudges: PendingSignal[], nowIso: string): Promise<boolean> {
  const recipients = await settingsService.getJsonArraySetting<string>(CS_NUDGE_EMAILS_SETTING, []);
  if (recipients.length === 0) {
    console.warn(`${TAG} ${nudges.length} cs_nudge(s) undelivered: AW-Settings ${CS_NUDGE_EMAILS_SETTING} is not set`);
    return false;
  }
  const subject = `Activation nudges: ${nudges.length} paying account(s) have not connected an ad account`;
  const intro =
    'These paying accounts have never connected an ad account (Meta, Google Ads or LinkedIn Ads). ' +
    'This is onboarding, not churn risk. Next step for CS: help the customer connect an ad account ' +
    'in Settings > Connected Accounts.';
  const lines = nudges.map(formatCsNudgeLine);
  const text = `${intro}\n\n${lines.map((l) => `- ${l}`).join('\n')}\n\nAccount-health sweep ${nowIso}`;
  const html =
    `<p>${emailService.escapeHtml(intro)}</p><ul>` +
    lines.map((l) => `<li>${emailService.escapeHtml(l)}</li>`).join('') +
    `</ul><p style="color:#6c757d;font-size:12px">Account-health sweep ${emailService.escapeHtml(nowIso)}</p>`;
  return (await emailService.sendEmail(recipients, subject, text, html)) === 'sent';
}

/** Undo a claim whose signal was not delivered, so the next run retries instead of treating it as sent. */
async function releaseClaim(userId: string, claimed: AccountHealthSignalState, prev: AccountHealthSignalState | null): Promise<void> {
  await putAccountHealthSignalState(
    userId,
    {
      ...claimed,
      lastEpisodeKey: prev?.lastEpisodeKey,
      lastSignalCodes: prev?.lastSignalCodes,
      lastSignalAt: prev?.lastSignalAt,
      lastSignalChannel: prev?.lastSignalChannel,
      csNudgeDeliveryStatus: prev?.csNudgeDeliveryStatus,
      version: claimed.version + 1,
    },
    claimed.version,
  ).catch((releaseError: unknown) => console.error(`${TAG} claim release failed for user ${userId}:`, releaseError));
}

/**
 * Finalizes a cs_nudge claim to `delivered` once the digest actually went out, so a later sweep's
 * `isStalePendingCsNudge` check never recovers (and re-sends) a nudge that was genuinely sent.
 * Best-effort: the CAS write only fails if something else already touched this exact version,
 * which the recovery timeout makes rare; a failure here means the next sweep may resend once,
 * which is a duplicate email, not a lost one.
 */
async function finalizeCsNudgeDelivered(userId: string, claimed: AccountHealthSignalState): Promise<void> {
  await putAccountHealthSignalState(
    userId,
    { ...claimed, csNudgeDeliveryStatus: 'delivered', version: claimed.version + 1 },
    claimed.version,
  ).catch((error: unknown) => console.error(`${TAG} cs_nudge delivery finalize failed for user ${userId}:`, error));
}

export interface AccountHealthSweepSummary {
  scanned: number;
  byState: Record<AccountHealthClassification['state'], number>;
  oncall: number;
  /** CS nudges delivered in this run's digest. */
  csNudges: number;
  /** CS nudges claimed but not delivered (no recipient list, or the send failed); retried next run. */
  csNudgeUndelivered: number;
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

/**
 * NOTE: `dryRun` skips alerts and writes but still reads live Google Ads delivery (read-only GAQL
 * searches, one set per connected Google account), so a dry run consumes Google API quota.
 */
export async function runAccountHealthClassifier(
  opts: { dryRun?: boolean; now?: number } = {},
): Promise<AccountHealthSweepSummary> {
  const summary: AccountHealthSweepSummary = {
    scanned: 0,
    byState: { activation_incomplete: 0, at_risk: 0, healthy: 0, insufficient_evidence: 0 },
    oncall: 0,
    csNudges: 0,
    csNudgeUndelivered: 0,
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
  // Checked here rather than only in server.ts's interval callback, so the immediate first run
  // cannot write state or page oncall from an instance that graceful shutdown is draining.
  if (!dryRun && !isCronEnabled()) {
    console.log(`${TAG} cron disabled on this instance (draining); skipping`);
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

  const pendingNudges: PendingSignal[] = [];
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
      if (decision.channel === 'cs_nudge' && decision.next) {
        console.info(`${TAG} cs_nudge ${logLine}`);
        pendingNudges.push({ user, result, claimed: decision.next, prev });
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
          await releaseClaim(user.userId, claimed, prev);
        }
      }
    } catch (error) {
      summary.evaluationFailed++;
      console.error(`${TAG} failed to evaluate user ${user.userId}:`, error);
    }
  }

  if (pendingNudges.length > 0) {
    let delivered = false;
    try {
      delivered = await sendCsNudgeDigest(pendingNudges, nowIso);
    } catch (error) {
      console.error(`${TAG} cs_nudge digest failed:`, error);
    }
    if (delivered) {
      summary.csNudges += pendingNudges.length;
      await Promise.all(pendingNudges.map((n) => finalizeCsNudgeDelivered(n.user.userId, n.claimed)));
    } else {
      summary.csNudgeUndelivered += pendingNudges.length;
      for (const n of pendingNudges) await releaseClaim(n.user.userId, n.claimed, n.prev);
    }
  }

  console.log(
    `${TAG} ${dryRun ? '[DRY RUN] ' : ''}scanned=${summary.scanned} ` +
      `at_risk=${summary.byState.at_risk} activation_incomplete=${summary.byState.activation_incomplete} ` +
      `insufficient_evidence=${summary.byState.insufficient_evidence} healthy=${summary.byState.healthy} ` +
      `oncall=${summary.oncall} csNudges=${summary.csNudges} csNudgeUndelivered=${summary.csNudgeUndelivered} ` +
      `needsReview=${summary.needsReview} ` +
      `silent=${summary.silent} lostRace=${summary.lostRace} alertFailed=${summary.alertFailed} ` +
      `evaluationFailed=${summary.evaluationFailed}`,
  );
  return summary;
}
