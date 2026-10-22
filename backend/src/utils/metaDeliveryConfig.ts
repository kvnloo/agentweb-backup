/**
 * ENG-2030 — delivery configuration the portal campaign/ad-set tables show so a user can
 * tell WHY spend concentrated where it did (budget, bid strategy, optimization event,
 * learning phase). Read-only projection of Graph API fields; never mutates anything.
 *
 * Absent fields are `null`, not 0 or "": the portal renders null as "—", and a fabricated
 * zero budget would read as a real (and alarming) configuration.
 */

/** Graph fields requested on /campaigns (budget lives here under CBO). */
export const CAMPAIGN_DELIVERY_FIELDS = 'daily_budget,lifetime_budget,bid_strategy';

/** Graph fields requested on /adsets (budget lives here when CBO is off). */
export const ADSET_DELIVERY_FIELDS =
  'daily_budget,lifetime_budget,bid_strategy,optimization_goal,learning_stage_info';

export interface DeliveryConfig {
  /** Account currency, major units (Graph returns minor units as a string). */
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  bidStrategy: string | null;
  optimizationGoal: string | null;
  /** learning_stage_info.status: LEARNING | SUCCESS | FAIL. */
  learningPhase: string | null;
}

function minorToMajor(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  // Graph reports "0" for "no budget at this level" — that is absence, not a $0 budget.
  if (!Number.isFinite(n) || n <= 0) return null;
  return n / 100;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function extractDeliveryConfig(entity: any): DeliveryConfig {
  return {
    dailyBudget: minorToMajor(entity?.daily_budget),
    lifetimeBudget: minorToMajor(entity?.lifetime_budget),
    bidStrategy: nonEmptyString(entity?.bid_strategy),
    optimizationGoal: nonEmptyString(entity?.optimization_goal),
    learningPhase: nonEmptyString(entity?.learning_stage_info?.status),
  };
}
