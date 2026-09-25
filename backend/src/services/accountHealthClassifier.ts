/**
 * Account-health classifier (ENG-2143, ENG-2128 surface C).
 *
 * Splits an AgentWeb account into one of:
 *  - `activation_incomplete`: no ad account was ever connected. An onboarding state for CS to
 *    nudge; never an at-risk or churn label (ENG-2133, decision D6).
 *  - `at_risk`: behavioural evidence that the account is not getting what it pays for — a failed
 *    payment or past-due subscription, campaigns with an approved budget that deliver nothing
 *    past the 24h grace window (ENG-1913), or a broken ad connection on an account whose ads
 *    requirement is current (ENG-2016 AC1).
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
  | 'activity_unknown';

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
  return {
    state: 'healthy',
    confidence: evidence.some((e) => e.code === 'delivery_not_read') ? 'medium' : 'high',
    ...base,
  };
}
