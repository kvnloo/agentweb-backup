/**
 * ENG-2046 A4 — per-account Meta spend ceilings, enforcement core.
 *
 * Pure: the caller supplies the account's policy and the proposed money write, both in Meta
 * minor units of the same account currency (the units normalizeMetaMoney already produces).
 * Where the policy is stored is deliberately out of scope here (data-plane slice).
 *
 * Fail closed on a malformed policy or amount: a ceiling that cannot be evaluated never
 * silently allows a money write.
 */
export interface MetaSpendCeilingPolicy {
  /** Highest daily budget allowed on any campaign/ad set of this account, minor units. */
  maxDailyBudget?: number;
  /** Highest allowed proposed/prior ratio for one budget change (e.g. 3 = at most 3x). */
  maxChangeRatio?: number;
}

export interface MetaSpendCeilingChange {
  field: 'daily_budget' | 'lifetime_budget' | 'budget_amount' | 'spend_cap' | 'bid_amount';
  proposed: unknown;
  prior?: unknown;
}

export type MetaSpendCeilingVerdict =
  | { allowed: true }
  | { allowed: false; code: 'SPEND_CEILING_EXCEEDED' | 'SPEND_CEILING_INVALID'; ceiling: string; message: string };

export const SPEND_CEILING_RAISE_PATH =
  'An account admin can raise this ceiling in the account spend-ceiling settings; do not split the change to get around it.';

const amount = (value: unknown): number | undefined => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

const validLimit = (value: unknown): boolean =>
  value === undefined || (typeof value === 'number' && Number.isFinite(value) && value > 0);

export function evaluateMetaSpendCeiling(
  policy: MetaSpendCeilingPolicy | null | undefined,
  change: MetaSpendCeilingChange
): MetaSpendCeilingVerdict {
  if (!policy || (policy.maxDailyBudget === undefined && policy.maxChangeRatio === undefined)) {
    return { allowed: true };
  }
  const invalid = (ceiling: string, why: string): MetaSpendCeilingVerdict => ({
    allowed: false,
    code: 'SPEND_CEILING_INVALID',
    ceiling,
    message: `Spend ceiling could not be evaluated (${why}); the write was not sent. ${SPEND_CEILING_RAISE_PATH}`,
  });
  if (!validLimit(policy.maxDailyBudget)) return invalid('maxDailyBudget', 'maxDailyBudget is not a positive number');
  if (!validLimit(policy.maxChangeRatio)) return invalid('maxChangeRatio', 'maxChangeRatio is not a positive number');

  const proposed = amount(change.proposed);
  if (proposed === undefined) return invalid('amount', `${change.field} is not a non-negative amount`);

  if (policy.maxDailyBudget !== undefined && change.field === 'daily_budget' && proposed > policy.maxDailyBudget) {
    return {
      allowed: false,
      code: 'SPEND_CEILING_EXCEEDED',
      ceiling: 'maxDailyBudget',
      message: `daily_budget ${proposed} exceeds this account's max daily budget of ${policy.maxDailyBudget} (minor units). ${SPEND_CEILING_RAISE_PATH}`,
    };
  }

  if (policy.maxChangeRatio !== undefined && change.field !== 'bid_amount' && change.prior !== undefined && change.prior !== null) {
    const prior = amount(change.prior);
    if (prior === undefined) return invalid('maxChangeRatio', `prior ${change.field} is not a non-negative amount`);
    // A zero prior daily_budget means no budget was set (adding one): there is no ratio to
    // apply, and maxDailyBudget has already capped it above. Every other zero prior (other
    // fields, or no maxDailyBudget) has no cap at all, so an increase from 0 still exceeds.
    if (prior === 0 && change.field === 'daily_budget' && policy.maxDailyBudget !== undefined) return { allowed: true };
    const exceeds = prior === 0 ? proposed > 0 : proposed / prior > policy.maxChangeRatio;
    if (exceeds) {
      const ratio = prior === 0 ? 'an increase from 0' : `${(proposed / prior).toFixed(2)}x`;
      return {
        allowed: false,
        code: 'SPEND_CEILING_EXCEEDED',
        ceiling: 'maxChangeRatio',
        message: `${change.field} change ${prior} -> ${proposed} is ${ratio}, above this account's max single-change ratio of ${policy.maxChangeRatio}x. ${SPEND_CEILING_RAISE_PATH}`,
      };
    }
  }
  return { allowed: true };
}
