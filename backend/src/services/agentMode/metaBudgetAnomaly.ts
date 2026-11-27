/** Both values must be in the same currency unit (the caller uses Meta minor units). */
export function classifyMetaBudgetChange(prior: unknown, proposed: unknown) {
  const amount = (value: unknown): number | undefined => {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const before = amount(prior);
  const after = amount(proposed);
  if (before === undefined || after === undefined) {
    return { severity: 'unknown' as const, ratio: null, prior: before, proposed: after };
  }
  return {
    severity: after > before * 10 ? 'critical' as const : after > before * 2 ? 'warning' as const : 'normal' as const,
    ratio: before > 0 ? after / before : null,
    prior: before,
    proposed: after,
  };
}

const BUDGET_FIELDS = ['daily_budget', 'lifetime_budget'] as const;
const unset = (value: unknown) => value === undefined || value === null || value === '';

/**
 * The prior value a budget change is compared against. A campaign / ad set Meta read back
 * successfully (it has an id) with NEITHER a daily nor a lifetime budget has no budget at all, so
 * adding one is a change from 0 — not an unverifiable one. Treating it as unknown blocked every
 * "add a budget to a campaign that had none" with META_BUDGET_UNVERIFIED. A failed read (no id)
 * stays unknown, and so does a field missing next to a budget that IS set (e.g. switching a
 * lifetime-budget object to a daily one), since that is not a 0 → new change.
 */
export function priorBudgetForComparison(prior: Record<string, unknown> | null | undefined, field: string): unknown {
  if (!prior || unset(prior.id)) return undefined;
  if (!(BUDGET_FIELDS as readonly string[]).includes(field) || !unset(prior[field])) return prior[field];
  return BUDGET_FIELDS.every((f) => unset(prior[f])) ? 0 : undefined;
}
