/**
 * Account-health classifier (ENG-2143, ENG-2128 surface C).
 *
 * Splits an AgentWeb account into one of:
 *  - `activation_incomplete`: no ad account was ever connected, or ads run to pages that carry no
 *    pixel the account owns (the Meta tracking monitor's finding). An onboarding state for CS to
 *    nudge; never an at-risk or churn label (ENG-2133, decision D6).
 *  - `at_risk`: behavioural evidence that the account is not getting what it pays for — a failed
 *    payment or past-due subscription, campaigns with an approved budget that deliver nothing
 *    past the 24h grace window (ENG-1913), a broken ad connection on an account whose ads
 *    requirement is current (ENG-2016 AC1), ad spend cut by half or more, leads that stopped
 *    while spend continued, or mostly thumbs-down ratings on delivered work.
 *  - `healthy`: the signals that were read show none of the above.
 *  - `insufficient_evidence`: a signal needed to decide was not read, or a broken connection
 *    cannot be tied to a current requirement. Stated explicitly instead of guessing (ENG-2016
 *    AC2, brain F15: an unread signal must never become a confident negative).
 *
 * Pure: every input is passed in, so the live cron and the backtest share one decision. Each
 * result carries the evidence that produced it and a confidence grade.
 */

import {
  classifyMetaAdConnection,
  hasUsableAdToken,
  type AdConnectionAccount,
  type AdConnectionState,
} from './clientHealthService';
import type { AccountCapabilityRequirement } from './accountCapabilityRequirementsDb';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** ENG-1913 AC4: a campaign younger than this is warming up, not stuck. */
export const ZERO_DELIVERY_GRACE_MS = 24 * HOUR_MS;
/** ENG-2016 AC1: a verified ads action counts as a current requirement for this long. */
export const RECENT_ADS_ACTION_MAX_AGE_MS = 30 * DAY_MS;
/** A failed payment older than one monthly cycle plus slack is no longer this cycle's signal. */
export const PAYMENT_FAILURE_LOOKBACK_MS = 35 * DAY_MS;
/** Activity recency is context only (ENG-2016 AC5); this is where "recent" ends. */
export const INACTIVITY_THRESHOLD_MS = 30 * DAY_MS;
/** Ad trends compare the last 14 complete days with the 14 before them. */
export const TREND_WINDOW_DAYS = 14;
/** Days each trend window must have collected before a trend is judged (unread is not zero). */
export const TREND_MIN_OBSERVED_DAYS = 10;
/** Recent spend at or below this share of the prior window is a spend drop. */
export const SPEND_DROP_RATIO = 0.5;
/** Leads in the prior window needed before "no leads now" counts as results stopping. */
export const RESULTS_DROP_MIN_BASELINE_LEADS = 3;
/** Explicit ratings older than this are not this month's sentiment. */
export const FEEDBACK_LOOKBACK_MS = 30 * DAY_MS;
/** Thumbs-down ratings needed (and they must outnumber thumbs-up) for negative feedback. */
export const NEGATIVE_FEEDBACK_MIN_DISLIKES = 3;

export type AccountHealthState = 'activation_incomplete' | 'at_risk' | 'healthy' | 'insufficient_evidence';
export type AccountHealthConfidence = 'high' | 'medium' | 'low';

export type EvidenceCode =
  | 'ads_never_connected'
  | 'ads_connected'
  | 'ads_connection_expired'
  | 'requirement_contracted'
  | 'requirement_recent_ads_action'
  | 'requirement_recent_spend'
  | 'requirement_unknown'
  | 'zero_delivery'
  | 'delivery_warming_up'
  | 'delivering'
  | 'delivery_not_read'
  | 'payment_failed'
  | 'subscription_past_due'
  | 'payments_clear'
  | 'payments_not_read'
  | 'recently_active'
  | 'inactive'
  | 'activity_unknown'
  | 'spend_drop'
  | 'results_drop'
  | 'ad_trend_steady'
  | 'ad_trend_not_evaluable'
  | 'negative_feedback'
  | 'feedback_clear'
  | 'feedback_not_read'
  | 'tracking_not_set_up'
  | 'tracking_ok'
  | 'tracking_not_read';

/**
 * `risk` evidence alone decides `at_risk`; `activation` decides `activation_incomplete`; `gap`
 * names a signal that could not be read; `context` corroborates and never decides.
 */
export type EvidenceKind = 'risk' | 'activation' | 'gap' | 'context';

export interface AccountHealthEvidence {
  code: EvidenceCode;
  kind: EvidenceKind;
  detail: string;
}

/** Ad-connection state across every ad platform. */
export interface AdConnectionSummary {
  state: 'never_connected' | 'connected' | 'expired';
  meta: AdConnectionState;
  /** Per non-Meta platform on record. */
  others: Partial<Record<'google_ads' | 'linkedin_ads', 'connected' | 'expired'>>;
  /** Latest token expiry across expired accounts, when `state` is `expired`. */
  expiredAt?: string;
}

const OTHER_AD_PLATFORMS = ['google_ads', 'linkedin_ads'] as const;

/**
 * Meta goes through clientHealthService.classifyMetaAdConnection (legacy `adAccount`, ad-account
 * type filter); Google Ads and LinkedIn Ads accounts use the same token rule (`hasUsableAdToken`).
 * Any usable account on any platform makes the account connected.
 */
export function classifyAdConnections(
  connectedAccounts: ReadonlyArray<AdConnectionAccount | null | undefined> | null | undefined,
  legacyAdAccount: string | undefined,
  nowMs: number,
): AdConnectionSummary {
  const meta = classifyMetaAdConnection(connectedAccounts, legacyAdAccount, nowMs);
  const others: AdConnectionSummary['others'] = {};
  const expiries: number[] = [];
  if (meta.connection === 'expired' && meta.expiredAt) expiries.push(Date.parse(meta.expiredAt));
  for (const platform of OTHER_AD_PLATFORMS) {
    const accounts = (connectedAccounts ?? []).filter(
      (acc): acc is AdConnectionAccount => acc?.platform === platform,
    );
    if (accounts.length === 0) continue;
    if (accounts.some((acc) => hasUsableAdToken(acc, nowMs))) {
      others[platform] = 'connected';
    } else {
      others[platform] = 'expired';
      expiries.push(Math.max(...accounts.map((acc) => acc.config?.token_expires_at ?? 0)));
    }
  }
  const otherStates = Object.values(others);
  if (meta.connection === 'connected' || otherStates.includes('connected')) {
    return { state: 'connected', meta: meta.connection, others };
  }
  if (meta.connection === 'expired' || otherStates.includes('expired')) {
    return {
      state: 'expired',
      meta: meta.connection,
      others,
      expiredAt: new Date(Math.max(...expiries)).toISOString(),
    };
  }
  return { state: 'never_connected', meta: meta.connection, others };
}

export type RequirementFields = Pick<AccountCapabilityRequirement, 'requirementSource' | 'requirementVerifiedAt'>;

export interface CurrentRequirement {
  status: 'required' | 'unknown';
  evidence: AccountHealthEvidence;
}

/**
 * Is ad integration required NOW? Read from the OPS-4 fields on AW-AccountCapabilityRequirements,
 * or from ad spend in the last 30 days (spend is itself a verified ads action). Historical
 * onboarding intent alone, a stale ads action, or an absent field is `unknown` — never `required`.
 */
export function resolveCurrentRequirement(
  row: RequirementFields | null | undefined,
  recentAdSpend: number | null | undefined,
  nowMs: number,
): CurrentRequirement {
  if (row?.requirementSource === 'contracted') {
    return {
      status: 'required',
      evidence: { code: 'requirement_contracted', kind: 'context', detail: 'ad integration is contractually required' },
    };
  }
  const verifiedMs = row?.requirementVerifiedAt ? Date.parse(row.requirementVerifiedAt) : NaN;
  if (
    row?.requirementSource === 'recent_ads_action' &&
    Number.isFinite(verifiedMs) &&
    nowMs - verifiedMs <= RECENT_ADS_ACTION_MAX_AGE_MS
  ) {
    return {
      status: 'required',
      evidence: {
        code: 'requirement_recent_ads_action',
        kind: 'context',
        detail: `verified ads action on ${new Date(verifiedMs).toISOString()}`,
      },
    };
  }
  if (typeof recentAdSpend === 'number' && recentAdSpend > 0) {
    return {
      status: 'required',
      evidence: { code: 'requirement_recent_spend', kind: 'context', detail: 'ad spend recorded in the last 30 days' },
    };
  }
  const why =
    row?.requirementSource === 'onboarding_intent'
      ? 'only historical onboarding intent is on record'
      : row?.requirementSource === 'recent_ads_action'
        ? 'the last verified ads action is older than 30 days'
        : 'no current requirement is recorded';
  return {
    status: 'unknown',
    evidence: { code: 'requirement_unknown', kind: 'gap', detail: `current ads requirement unknown: ${why}` },
  };
}

export interface CampaignDeliveryInput {
  campaignId: string;
  /** Platform status. Only an enabled campaign (Google `ENABLED`, Meta `ACTIVE`) can be stuck. */
  status: string;
  /** Approved daily budget in the account currency. */
  approvedDailyBudget: number;
  /** ISO time the campaign went live. */
  liveSince: string;
  /** Impressions and clicks since going live (or over the caller's lookback window). */
  impressions: number;
  clicks: number;
}

export interface ZeroDeliveryResult {
  stuck: string[];
  warmingUp: string[];
  delivering: string[];
  /** Paused, removed, zero-budget, or with an unreadable live time: not a delivery failure. */
  excluded: string[];
}

const ENABLED_STATUSES = new Set(['ENABLED', 'ACTIVE']);

/**
 * ENG-1913: an enabled campaign with a positive approved budget that has produced no impressions
 * and no clicks more than 24h after going live is stuck. A paused campaign is expected zero
 * delivery (AC3); one inside the grace window is warming up (AC4).
 */
export function evaluateZeroDelivery(
  campaigns: ReadonlyArray<CampaignDeliveryInput>,
  nowMs: number,
): ZeroDeliveryResult {
  const result: ZeroDeliveryResult = { stuck: [], warmingUp: [], delivering: [], excluded: [] };
  for (const campaign of campaigns) {
    const liveSinceMs = Date.parse(campaign.liveSince);
    if (
      !ENABLED_STATUSES.has(campaign.status.toUpperCase()) ||
      !(campaign.approvedDailyBudget > 0) ||
      !Number.isFinite(liveSinceMs)
    ) {
      result.excluded.push(campaign.campaignId);
    } else if (campaign.impressions > 0 || campaign.clicks > 0) {
      result.delivering.push(campaign.campaignId);
    } else if (nowMs - liveSinceMs < ZERO_DELIVERY_GRACE_MS) {
      result.warmingUp.push(campaign.campaignId);
    } else {
      result.stuck.push(campaign.campaignId);
    }
  }
  return result;
}

export interface PaymentEventInput {
  eventType: string;
  timestamp: string;
}

/** One collected ad-reporting day (YYYY-MM-DD) for the account, summed over its ad accounts. */
export interface AdDayInput {
  date: string;
  spend: number;
  leads: number;
}

/** An explicit rating the customer gave delivered work (AW-ChatSessions `feedbacks`). */
export interface FeedbackInput {
  type: string;
  timestamp: string;
}

/** The Meta tracking monitor's pixel findings for the account's connected ad accounts. */
export interface TrackingInput {
  /** Active conversion ads whose landing page carries no pixel the ad account owns. */
  destinationsWithoutOwnedPixel: number;
  /** Deployed pages we built that carry no pixel the account owns. */
  landingPagesWithoutOwnedPixel: number;
}

/**
 * Merge AW-AdsMetricsSnapshots rows into collected days. `account_day` rows mark a date as
 * collected (even with zero campaigns) and carry the lead count; their `spend` is always 0 by
 * design, so spend comes from the `campaign` rows (which exist only for campaigns that delivered).
 */
export function buildAdDays(
  accountDayRows: ReadonlyArray<{ date: string; totalLeadCount?: number }>,
  campaignRows: ReadonlyArray<{ date: string; spend: number }>,
): AdDayInput[] {
  const days = new Map<string, AdDayInput>();
  const day = (date: string) => {
    const existing = days.get(date);
    if (existing) return existing;
    const created: AdDayInput = { date, spend: 0, leads: 0 };
    days.set(date, created);
    return created;
  };
  for (const row of accountDayRows) {
    const leads = Number(row.totalLeadCount ?? 0);
    day(row.date).leads += Number.isFinite(leads) ? leads : 0;
  }
  for (const row of campaignRows) {
    day(row.date).spend += Number.isFinite(row.spend) ? row.spend : 0;
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

const dateLabel = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Spend and results trend: the last TREND_WINDOW_DAYS complete days against the window before.
 * A window with too few collected days is not judged — a missing day is unknown, not zero.
 */
export function evaluateAdTrend(adDays: ReadonlyArray<AdDayInput>, nowMs: number): AccountHealthEvidence[] {
  const todayMs = Date.parse(`${dateLabel(nowMs)}T00:00:00.000Z`);
  const recentStart = dateLabel(todayMs - TREND_WINDOW_DAYS * DAY_MS);
  const baselineStart = dateLabel(todayMs - 2 * TREND_WINDOW_DAYS * DAY_MS);
  const today = dateLabel(todayMs);
  const recent = adDays.filter((d) => d.date >= recentStart && d.date < today);
  const baseline = adDays.filter((d) => d.date >= baselineStart && d.date < recentStart);
  if (recent.length < TREND_MIN_OBSERVED_DAYS || baseline.length < TREND_MIN_OBSERVED_DAYS) {
    return [{
      code: 'ad_trend_not_evaluable',
      kind: 'context',
      detail: `ad trend not judged: ${baseline.length} and ${recent.length} of ${TREND_WINDOW_DAYS} days collected in the prior and recent windows`,
    }];
  }
  const sum = (days: AdDayInput[], key: 'spend' | 'leads') => days.reduce((total, d) => total + d[key], 0);
  const baselineSpend = sum(baseline, 'spend');
  const recentSpend = sum(recent, 'spend');
  const baselineLeads = sum(baseline, 'leads');
  const recentLeads = sum(recent, 'leads');
  if (!(baselineSpend > 0)) {
    return [{ code: 'ad_trend_not_evaluable', kind: 'context', detail: 'ad trend not judged: no ad spend in the prior window' }];
  }
  const evidence: AccountHealthEvidence[] = [];
  if (recentSpend <= SPEND_DROP_RATIO * baselineSpend) {
    const pct = Math.round((1 - recentSpend / baselineSpend) * 100);
    evidence.push({
      code: 'spend_drop',
      kind: 'risk',
      detail: `ad spend fell ${pct}% (last ${TREND_WINDOW_DAYS} days against the ${TREND_WINDOW_DAYS} before)`,
    });
  }
  if (baselineLeads >= RESULTS_DROP_MIN_BASELINE_LEADS && recentLeads === 0 && recentSpend > 0) {
    evidence.push({
      code: 'results_drop',
      kind: 'risk',
      detail: `no leads in the last ${TREND_WINDOW_DAYS} days while ads kept spending (${baselineLeads} in the ${TREND_WINDOW_DAYS} before)`,
    });
  }
  if (evidence.length === 0) {
    evidence.push({
      code: 'ad_trend_steady',
      kind: 'context',
      detail: `ad spend and leads held up (${recentLeads} leads in the last ${TREND_WINDOW_DAYS} days, ${baselineLeads} before)`,
    });
  }
  return evidence;
}

/** Explicit ratings in the last 30 days: negative when thumbs-down are at least 3 and the majority. */
export function evaluateFeedback(feedback: ReadonlyArray<FeedbackInput>, nowMs: number): AccountHealthEvidence {
  let likes = 0;
  let dislikes = 0;
  for (const rating of feedback) {
    const at = Date.parse(rating.timestamp);
    if (!Number.isFinite(at) || at > nowMs || nowMs - at > FEEDBACK_LOOKBACK_MS) continue;
    if (rating.type === 'dislike') dislikes++;
    else if (rating.type === 'like') likes++;
  }
  if (dislikes >= NEGATIVE_FEEDBACK_MIN_DISLIKES && dislikes > likes) {
    return {
      code: 'negative_feedback',
      kind: 'risk',
      detail: `${dislikes} of ${dislikes + likes} ratings on delivered work in the last 30 days were thumbs-down`,
    };
  }
  return { code: 'feedback_clear', kind: 'context', detail: `${dislikes} thumbs-down and ${likes} thumbs-up in the last 30 days` };
}

export interface AccountHealthSignals {
  nowMs: number;
  connectedAccounts: ReadonlyArray<AdConnectionAccount | null | undefined> | null | undefined;
  legacyAdAccount?: string;
  /** The account's `ad_platform_integration` row, or null when it has none. */
  requirement: RequirementFields | null;
  subscriptionStatus?: string;
  /** ISO end of the current billing period (AW-Users current_period_end). */
  currentPeriodEnd?: string;
  /** AW-PaymentHistory events. null = not read, which is different from "no events". */
  payments: ReadonlyArray<PaymentEventInput> | null;
  /** Per-campaign delivery. null = not read (no zero-delivery verdict either way). */
  campaigns: ReadonlyArray<CampaignDeliveryInput> | null;
  /** Ad spend over the last 30 days (AW-AdsMetricsSnapshots). null = not read or incomplete. */
  recentAdSpend: number | null;
  lastActiveAt?: string | null;
  /** Collected ad days (see buildAdDays). null / absent = not read (no trend verdict either way). */
  adDays?: ReadonlyArray<AdDayInput> | null;
  /** Explicit ratings on delivered work. null / absent = not read. */
  feedback?: ReadonlyArray<FeedbackInput> | null;
  /** Meta tracking monitor findings. null / absent = not read. */
  tracking?: TrackingInput | null;
}

export interface AccountHealthClassification {
  state: AccountHealthState;
  confidence: AccountHealthConfidence;
  evidence: AccountHealthEvidence[];
  connection: AdConnectionSummary;
  requirement: CurrentRequirement['status'];
  /** Billing-cycle key used for dedupe (ENG-2016 AC3): the period end date, else the UTC month. */
  billingCycle: string;
}

/** Codes whose `at_risk` verdict is high confidence on its own. */
const HIGH_CONFIDENCE_RISKS: ReadonlySet<EvidenceCode> = new Set([
  'payment_failed',
  'subscription_past_due',
  'zero_delivery',
]);

export function billingCycleKey(currentPeriodEnd: string | undefined, nowMs: number): string {
  const endMs = currentPeriodEnd ? Date.parse(currentPeriodEnd) : NaN;
  if (Number.isFinite(endMs)) return new Date(endMs).toISOString().slice(0, 10);
  return `month:${new Date(nowMs).toISOString().slice(0, 7)}`;
}

function unresolvedPaymentFailure(payments: ReadonlyArray<PaymentEventInput>, nowMs: number): string | null {
  let lastFailure = -Infinity;
  let lastSuccess = -Infinity;
  for (const event of payments) {
    const at = Date.parse(event.timestamp);
    if (!Number.isFinite(at) || at > nowMs) continue;
    if (event.eventType === 'payment_failed') lastFailure = Math.max(lastFailure, at);
    if (event.eventType === 'payment_succeeded') lastSuccess = Math.max(lastSuccess, at);
  }
  // A success stamped at the same instant (a Stripe retry within one webhook batch) resolves it.
  if (lastFailure === -Infinity || lastSuccess >= lastFailure) return null;
  if (nowMs - lastFailure > PAYMENT_FAILURE_LOOKBACK_MS) return null;
  return new Date(lastFailure).toISOString();
}

export function classifyAccountHealth(signals: AccountHealthSignals): AccountHealthClassification {
  const { nowMs } = signals;
  const evidence: AccountHealthEvidence[] = [];
  const connection = classifyAdConnections(signals.connectedAccounts, signals.legacyAdAccount, nowMs);
  const requirement = resolveCurrentRequirement(signals.requirement, signals.recentAdSpend, nowMs);

  // Payments.
  if (signals.subscriptionStatus === 'past_due') {
    evidence.push({ code: 'subscription_past_due', kind: 'risk', detail: 'subscription is past due' });
  }
  if (signals.payments === null) {
    evidence.push({ code: 'payments_not_read', kind: 'gap', detail: 'payment history was not read' });
  } else {
    const failedAt = unresolvedPaymentFailure(signals.payments, nowMs);
    evidence.push(
      failedAt
        ? { code: 'payment_failed', kind: 'risk', detail: `payment failed ${failedAt} with no later successful payment` }
        : { code: 'payments_clear', kind: 'context', detail: 'no unresolved payment failure in the last 35 days' },
    );
  }

  // Connection and requirement.
  if (connection.state === 'never_connected') {
    evidence.push({ code: 'ads_never_connected', kind: 'activation', detail: 'no ad account has ever been connected' });
    // A required-but-never-connected account is still activation: it tells CS the nudge is urgent.
    if (requirement.status === 'required') evidence.push(requirement.evidence);
  } else if (connection.state === 'expired') {
    evidence.push({
      code: 'ads_connection_expired',
      kind: requirement.status === 'required' ? 'risk' : 'gap',
      detail: `every ad account token has expired (latest ${connection.expiredAt})`,
    });
    evidence.push(requirement.evidence);
  } else {
    evidence.push({ code: 'ads_connected', kind: 'context', detail: 'at least one ad account is connected' });
  }

  // Delivery (ENG-1913). Only meaningful once something is connected.
  if (connection.state === 'connected') {
    if (signals.campaigns === null) {
      evidence.push({ code: 'delivery_not_read', kind: 'gap', detail: 'campaign delivery was not read' });
    } else {
      const delivery = evaluateZeroDelivery(signals.campaigns, nowMs);
      if (delivery.stuck.length > 0) {
        evidence.push({
          code: 'zero_delivery',
          kind: 'risk',
          detail: `${delivery.stuck.length} enabled campaign(s) with an approved budget have delivered nothing for over 24h`,
        });
      }
      if (delivery.warmingUp.length > 0) {
        evidence.push({
          code: 'delivery_warming_up',
          kind: 'context',
          detail: `${delivery.warmingUp.length} campaign(s) inside the 24h grace window`,
        });
      }
      if (delivery.delivering.length > 0) {
        evidence.push({
          code: 'delivering',
          kind: 'context',
          detail: `${delivery.delivering.length} campaign(s) delivering`,
        });
      }
    }
  }

  // Ad trend: spend drop and results drop (ENG-2143 audit). Only meaningful once connected.
  if (connection.state === 'connected') {
    if (signals.adDays) evidence.push(...evaluateAdTrend(signals.adDays, nowMs));
    else evidence.push({ code: 'ad_trend_not_evaluable', kind: 'context', detail: 'ad metrics were not read' });
  }

  // Explicit feedback on delivered work.
  evidence.push(
    signals.feedback
      ? evaluateFeedback(signals.feedback, nowMs)
      : { code: 'feedback_not_read', kind: 'context', detail: 'feedback was not read' },
  );

  // Tracking: ads or pages without an owned pixel are setup work (activation), never risk.
  if (connection.state === 'connected') {
    const tracking = signals.tracking;
    if (!tracking) {
      evidence.push({ code: 'tracking_not_read', kind: 'context', detail: 'pixel tracking was not checked' });
    } else if (tracking.destinationsWithoutOwnedPixel + tracking.landingPagesWithoutOwnedPixel > 0) {
      evidence.push({
        code: 'tracking_not_set_up',
        kind: 'activation',
        detail:
          `${tracking.destinationsWithoutOwnedPixel} active ad destination(s) and ` +
          `${tracking.landingPagesWithoutOwnedPixel} built page(s) carry no pixel the account owns`,
      });
    } else {
      evidence.push({ code: 'tracking_ok', kind: 'context', detail: 'checked destinations carry an owned pixel' });
    }
  }

  // Activity recency: context only. General engagement neither creates nor hides a risk (ENG-2016 AC5).
  const activeMs = signals.lastActiveAt ? Date.parse(signals.lastActiveAt) : NaN;
  if (!Number.isFinite(activeMs)) {
    evidence.push({ code: 'activity_unknown', kind: 'context', detail: 'no activity timestamp on record' });
  } else if (nowMs - activeMs > INACTIVITY_THRESHOLD_MS) {
    evidence.push({ code: 'inactive', kind: 'context', detail: `last active ${new Date(activeMs).toISOString()}` });
  } else {
    evidence.push({ code: 'recently_active', kind: 'context', detail: `last active ${new Date(activeMs).toISOString()}` });
  }

  const base = {
    evidence,
    connection,
    requirement: requirement.status,
    billingCycle: billingCycleKey(signals.currentPeriodEnd, nowMs),
  };
  const risks = evidence.filter((e) => e.kind === 'risk');
  if (risks.length > 0) {
    const high =
      risks.some((e) => HIGH_CONFIDENCE_RISKS.has(e.code)) || requirement.evidence.code === 'requirement_contracted';
    return { state: 'at_risk', confidence: high ? 'high' : 'medium', ...base };
  }
  if (connection.state === 'never_connected') {
    return { state: 'activation_incomplete', confidence: 'high', ...base };
  }
  if (evidence.some((e) => e.code === 'ads_connection_expired' || e.code === 'payments_not_read')) {
    return { state: 'insufficient_evidence', confidence: 'low', ...base };
  }
  if (evidence.some((e) => e.code === 'tracking_not_set_up')) {
    return { state: 'activation_incomplete', confidence: 'medium', ...base };
  }
  return {
    state: 'healthy',
    confidence: evidence.some((e) => e.code === 'delivery_not_read') ? 'medium' : 'high',
    ...base,
  };
}
