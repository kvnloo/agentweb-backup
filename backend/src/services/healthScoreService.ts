/**
 * healthScoreService (C2 — CRM Unification v1).
 *
 * Computes a 0-100 health score for Contacts in lifecycle {paying, at_risk}.
 * Parallel to heatScoreService but tuned for retention — positive signals are
 * about usage and engagement; penalties are about billing problems and silence.
 *
 * Rules (spec — https://www.notion.so/34209247c951812fbd63e551eaf15b71):
 *   +50 active Stripe subscription in good standing
 *   +25 recent Emma chat session <7d
 *   +15 engagement reply in <14d
 *   -30 subscription past_due
 *   -50 no usage event >30d
 *   -40 open support_issue event >7d unresolved
 *   Clamp 0-100
 *
 * Also exposes a lifecycle-transition helper: when health drops below
 * HEALTH_AT_RISK_THRESHOLD (40) on a 'paying' contact, they should flip to
 * 'at_risk'. The helper is a pure pair (score, lifecycle-hint); persistence
 * is the caller's job (lifecycleService, C3).
 */

export type SubscriptionState = 'active' | 'trialing' | 'past_due' | 'canceled' | 'none';

export interface HealthScoreSignals {
  /** Stripe subscription status for this contact (or 'none' if no sub found). */
  subscriptionState?: SubscriptionState;
  /** ISO timestamp of the most recent Emma chat session start. */
  lastEmmaSessionAt?: string | null;
  /** ISO timestamp of the most recent engagement reply (LinkedIn, email, etc.). */
  lastEngagementReplyAt?: string | null;
  /** ISO timestamp of the most recent usage event (any source). */
  lastUsageAt?: string | null;
  /** ISO timestamp when an unresolved support_issue event was opened. */
  unresolvedSupportIssueOpenedAt?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const HEALTH_AT_RISK_THRESHOLD = 40;

function msAgo(ts: string | null | undefined, now: Date): number | null {
  if (!ts) return null;
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return null;
  const diff = now.getTime() - parsed;
  // Guard against clock skew: future timestamps are treated as "unknown" rather
  // than "just now", to avoid scoring nonsense.
  return diff < 0 ? null : diff;
}

export function computeHealthScore(
  signals: HealthScoreSignals,
  now: Date = new Date()
): number {
  let score = 0;

  // Positive: active subscription.
  if (signals.subscriptionState === 'active' || signals.subscriptionState === 'trialing') {
    score += 50;
  }

  // Positive: recent Emma session (<7d).
  const emmaAge = msAgo(signals.lastEmmaSessionAt, now);
  if (emmaAge !== null && emmaAge <= 7 * DAY_MS) {
    score += 25;
  }

  // Positive: engagement reply in the last 14 days.
  const replyAge = msAgo(signals.lastEngagementReplyAt, now);
  if (replyAge !== null && replyAge <= 14 * DAY_MS) {
    score += 15;
  }

  // Penalty: past-due subscription.
  if (signals.subscriptionState === 'past_due') {
    score -= 30;
  }

  // Penalty: no usage in 30+ days. If we have never seen a usage event, treat
  // that as silence too.
  const usageAge = msAgo(signals.lastUsageAt, now);
  if (usageAge === null || usageAge > 30 * DAY_MS) {
    score -= 50;
  }

  // Penalty: an unresolved support issue open for more than 7 days.
  const supportAge = msAgo(signals.unresolvedSupportIssueOpenedAt, now);
  if (supportAge !== null && supportAge > 7 * DAY_MS) {
    score -= 40;
  }

  if (score < 0) score = 0;
  if (score > 100) score = 100;

  return score;
}

/**
 * Decide whether a 'paying' contact should transition to 'at_risk'.
 * Returns the new lifecycle if a transition is warranted, or null otherwise.
 *
 * Callers (lifecycleService C3) are responsible for persisting the change.
 */
export function shouldTransitionToAtRisk(
  currentLifecycle: string,
  healthScore: number
): 'at_risk' | null {
  if (currentLifecycle === 'paying' && healthScore < HEALTH_AT_RISK_THRESHOLD) {
    return 'at_risk';
  }
  return null;
}

/** Mirror helper: if an at_risk contact has recovered, flip back to 'paying'. */
export function shouldRecoverToPaying(
  currentLifecycle: string,
  healthScore: number
): 'paying' | null {
  if (currentLifecycle === 'at_risk' && healthScore >= HEALTH_AT_RISK_THRESHOLD) {
    return 'paying';
  }
  return null;
}

/**
 * Async wrapper for per-contact computation.
 */
export async function computeForContact(
  contactId: string,
  fetchers: { loadSignals: (contactId: string) => Promise<HealthScoreSignals> }
): Promise<number> {
  const signals = await fetchers.loadSignals(contactId);
  return computeHealthScore(signals);
}

export async function recomputeBatch(
  contactIds: string[],
  fetchers: { loadSignals: (contactId: string) => Promise<HealthScoreSignals> }
): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  for (const id of contactIds) {
    results.set(id, await computeForContact(id, fetchers));
  }
  return results;
}
