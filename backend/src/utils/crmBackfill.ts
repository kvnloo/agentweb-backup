/**
 * Pure-logic helpers used by the CRM score backfill script
 * (backend/scripts/backfill-crm-scores.ts).
 *
 * Extracted so the compute path is unit-testable without DynamoDB / Stripe.
 * The script itself is thin orchestration: scan → for-each lead, fetch user,
 * call computeBackfillScores(), write results.
 *
 * Task: https://www.notion.so/34709247c9518151811fdd15808af544
 */

import type { SubscriptionState } from '../services/healthScoreService';
import { computeHeatScore, type HeatScoreSignals } from '../services/heatScoreService';
import { computeHealthScore, type HealthScoreSignals } from '../services/healthScoreService';
import { computeLifecycle, type LifecycleStage, type LifecycleSignals } from '../services/lifecycleService';

/** Minimal shape the backfill consumes from AW-Leads rows. */
export interface BackfillLead {
  listId: string;
  leadId: string;
  email?: string | null;
  status?: string | null;
  isICP?: boolean | number;
  contactStatus?: 'active' | 'do-not-contact' | 'unsubscribed' | null;
  lifecycle?: LifecycleStage | null;
  heatScore?: number | null;
  healthScore?: number | null;
  dealIds?: string[];
}

/** Minimal shape the backfill consumes from AW-Users rows. */
export interface BackfillUser {
  userId: string;
  email: string;
  stripe_customer_id?: string;
  /**
   * Stripe subscription_status stored on the user row (written by the Stripe
   * sync/webhook flow). Preferred over a live Stripe API call — decouples the
   * backfill from rate limits.
   */
  subscription_status?: string | null;
  lastLoginTime?: string;
  lastActiveAt?: string;
}

export interface BackfillSignals {
  lead: BackfillLead;
  user: BackfillUser | null;
  /** Optional ISO timestamps from timeline events (may be null when none found). */
  lastEngagementAt?: string | null;
  lastUsageAt?: string | null;
  lastEmmaSessionAt?: string | null;
  lastEngagementReplyAt?: string | null;
  unresolvedSupportIssueOpenedAt?: string | null;
  /** Stages of open deals attached to this contact. */
  openDealStages?: string[];
}

export interface BackfillScores {
  lifecycle: LifecycleStage;
  heatScore: number;
  healthScore: number;
}

/**
 * Map a raw Stripe subscription_status string to the SubscriptionState union
 * used by lifecycle/health compute.
 */
export function mapSubscriptionState(status: string | null | undefined): SubscriptionState {
  if (!status) return 'none';
  const s = status.toLowerCase().trim();
  if (s === 'active') return 'active';
  if (s === 'trialing') return 'trialing';
  if (s === 'past_due' || s === 'unpaid') return 'past_due';
  if (s === 'canceled' || s === 'cancelled' || s === 'incomplete_expired') return 'canceled';
  return 'none';
}

/**
 * Returns the most recent ISO timestamp across candidates, or null if none.
 * Malformed / empty strings are ignored.
 */
export function pickLatestTimestamp(...candidates: Array<string | null | undefined>): string | null {
  let bestMs = -Infinity;
  let best: string | null = null;
  for (const c of candidates) {
    if (!c) continue;
    const ms = Date.parse(c);
    if (Number.isNaN(ms)) continue;
    if (ms > bestMs) {
      bestMs = ms;
      best = c;
    }
  }
  return best;
}

/**
 * True when the lead already has all three scores set — the backfill should
 * skip it (idempotency guard).
 */
export function isLeadAlreadyBackfilled(lead: BackfillLead): boolean {
  return (
    lead.lifecycle != null &&
    typeof lead.heatScore === 'number' &&
    typeof lead.healthScore === 'number'
  );
}

/**
 * Pure compute: given the lead, its matched user, and any timeline signals,
 * return the three scores the backfill should write. Never throws; every
 * missing input has a defined fallback so the script can keep going.
 */
export function computeBackfillScores(
  signals: BackfillSignals,
  now: Date = new Date()
): BackfillScores {
  const { lead, user } = signals;

  const subscriptionState = mapSubscriptionState(user?.subscription_status);
  const hasUserRecord = user != null;
  const hasActiveSubscription =
    subscriptionState === 'active' || subscriptionState === 'trialing';

  const lastActivityAt = pickLatestTimestamp(
    signals.lastEngagementAt,
    signals.lastUsageAt,
    signals.lastEmmaSessionAt,
    signals.lastEngagementReplyAt,
    user?.lastActiveAt,
    user?.lastLoginTime
  );

  // Lifecycle: spec rules in lifecycleService. currentLifecycle threading keeps
  // at_risk stable for already-paying users.
  const lifecycleSignals: LifecycleSignals = {
    email: lead.email ?? undefined,
    hasUserRecord,
    subscriptionState,
    lastActivityAt,
    lastUsageAt: signals.lastUsageAt ?? null,
    currentLifecycle: lead.lifecycle ?? null,
    openDealStages: signals.openDealStages,
  };
  const lifecycle = computeLifecycle(lifecycleSignals, now);

  // Heat score: prospecting signals.
  const heatSignals: HeatScoreSignals = {
    hasUserRecord,
    hasActiveSubscription,
    status: lead.status ?? null,
    openDealStages: signals.openDealStages,
    lastEngagementAt: signals.lastEngagementAt ?? null,
    isICP:
      typeof lead.isICP === 'number' ? lead.isICP === 1 : Boolean(lead.isICP),
    contactStatus: lead.contactStatus ?? null,
  };
  const heatScore = computeHeatScore(heatSignals, now);

  // Health score: retention signals — only really meaningful for paying/at_risk,
  // but cheap to compute for everyone so the field is never null.
  const healthSignals: HealthScoreSignals = {
    subscriptionState,
    lastEmmaSessionAt: signals.lastEmmaSessionAt ?? null,
    lastEngagementReplyAt: signals.lastEngagementReplyAt ?? null,
    lastUsageAt: signals.lastUsageAt ?? null,
    unresolvedSupportIssueOpenedAt: signals.unresolvedSupportIssueOpenedAt ?? null,
  };
  const healthScore = computeHealthScore(healthSignals, now);

  return { lifecycle, heatScore, healthScore };
}
