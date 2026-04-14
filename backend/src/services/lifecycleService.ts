/**
 * lifecycleService (C3 — CRM Unification v1).
 *
 * Pure compute function that returns the lifecycle stage a Contact SHOULD be
 * in, based on their current Stripe status, open deals, health score, and
 * engagement timestamps.
 *
 * Rules (priority order, first match wins):
 *   1. subscription canceled OR no activity >60d      → 'churned'
 *   2. past_due OR healthScore<40 OR no usage >30d    → 'at_risk'   (only if currently paying)
 *   3. subscription 'active' (non-trialing)           → 'paying'
 *   4. subscription 'trialing'                        → 'trialing'
 *   5. has open Deal (stage not Won/Lost)             → 'in_deal'
 *   6. has AW-Users record, no deal, no sub           → 'signed_up'
 *   7. has email                                      → 'inbox'
 *   8. domain-only, no email                          → 'unknown'
 *
 * The compute function is pure and deterministic. The applyAndUpdate wrapper
 * (async, injected persistors) reads signals, computes, and — if the lifecycle
 * changed — persists the new value and logs a 'lifecycle.changed' event.
 *
 * Spec: https://www.notion.so/34209247c9518185a0bffa800cf20eea
 */

import type { SubscriptionState } from './healthScoreService';

export type LifecycleStage =
  | 'unknown'
  | 'inbox'
  | 'signed_up'
  | 'in_deal'
  | 'trialing'
  | 'paying'
  | 'at_risk'
  | 'churned';

export interface LifecycleSignals {
  email?: string | null;
  domain?: string | null;
  hasUserRecord?: boolean;
  subscriptionState?: SubscriptionState;
  /** ISO timestamp of the most recent known activity (any signal). */
  lastActivityAt?: string | null;
  /** ISO timestamp of the most recent usage event specifically. */
  lastUsageAt?: string | null;
  /** Current health score (0-100), used for paying→at_risk transitions. */
  healthScore?: number | null;
  /** Currently-computed lifecycle — used for stickiness rules (at_risk only applies from paying). */
  currentLifecycle?: LifecycleStage | null;
  /** Stages of open deals (omit closed). */
  openDealStages?: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function msAgo(ts: string | null | undefined, now: Date): number | null {
  if (!ts) return null;
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return null;
  const diff = now.getTime() - parsed;
  return diff < 0 ? null : diff;
}

function hasOpenDeal(openDealStages: string[] | undefined): boolean {
  if (!openDealStages || openDealStages.length === 0) return false;
  return openDealStages.some(stage => {
    const s = String(stage).toLowerCase();
    return s !== 'won' && s !== 'lost';
  });
}

export function computeLifecycle(
  signals: LifecycleSignals,
  now: Date = new Date()
): LifecycleStage {
  const { subscriptionState, hasUserRecord, email, domain, currentLifecycle } = signals;
  const activityAge = msAgo(signals.lastActivityAt, now);
  const usageAge = msAgo(signals.lastUsageAt, now);

  // Rule 1: churned.
  if (subscriptionState === 'canceled') return 'churned';
  if (activityAge !== null && activityAge > 60 * DAY_MS) return 'churned';

  // Rule 2: at_risk — only applies when the customer is *currently* paying or
  // already at_risk (spec: "no usage 30d while paying"). Otherwise the signal
  // might be a free-tier user that we don't want to flag as "at risk" (risk
  // of what?).
  const isOrWasPaying = currentLifecycle === 'paying' || currentLifecycle === 'at_risk';
  if (isOrWasPaying) {
    if (subscriptionState === 'past_due') return 'at_risk';
    if (typeof signals.healthScore === 'number' && signals.healthScore < 40) return 'at_risk';
    if (usageAge !== null && usageAge > 30 * DAY_MS) return 'at_risk';
  }

  // Rule 3 & 4: subscription-driven.
  if (subscriptionState === 'active') return 'paying';
  if (subscriptionState === 'trialing') return 'trialing';

  // Rule 5: open deal.
  if (hasOpenDeal(signals.openDealStages)) return 'in_deal';

  // Rule 6: signed-up but no deal, no sub.
  if (hasUserRecord) return 'signed_up';

  // Rule 7 & 8: visibility fallback.
  if (email && email.trim()) return 'inbox';
  if (domain && domain.trim()) return 'unknown';
  return 'unknown';
}

export interface ApplyDeps {
  loadSignals: (contactId: string) => Promise<LifecycleSignals>;
  persistLifecycle: (contactId: string, lifecycle: LifecycleStage) => Promise<void>;
  logTransitionEvent: (
    contactId: string,
    from: LifecycleStage | null,
    to: LifecycleStage
  ) => Promise<void>;
}

export interface ApplyResult {
  contactId: string;
  previous: LifecycleStage | null;
  current: LifecycleStage;
  changed: boolean;
}

/**
 * Read signals, compute target lifecycle, and — if different from current —
 * persist the update and log a `lifecycle.changed` event.
 *
 * No-op when the lifecycle is unchanged (neither persist nor event fires).
 */
export async function applyAndUpdate(
  contactId: string,
  deps: ApplyDeps,
  now: Date = new Date()
): Promise<ApplyResult> {
  const signals = await deps.loadSignals(contactId);
  const previous = signals.currentLifecycle ?? null;
  const next = computeLifecycle(signals, now);

  if (previous === next) {
    return { contactId, previous, current: next, changed: false };
  }

  await deps.persistLifecycle(contactId, next);
  await deps.logTransitionEvent(contactId, previous, next);
  return { contactId, previous, current: next, changed: true };
}
