/**
 * ENG-2155: lifecycle is a semantic stage, not a nullable storage attribute.
 *
 * Full equality filtering still uses the stored lifecycle until search/delete have a
 * shared live-signal join (AW-Users + ContactEvents + Deals). Presence is different:
 * computeLifecycle is total and always resolves a stage, including `unknown`, so
 * attribute absence must never make `lifecycle is_empty` true.
 *
 * Return undefined for every filter this helper does not own.
 */
export function matchLifecyclePresenceFilter(
  field: string,
  operator: string,
): boolean | undefined {
  if (field !== 'lifecycle') return undefined;
  if (operator === 'is_empty') return false;
  if (operator === 'is_not_empty') return true;
  return undefined;
}
