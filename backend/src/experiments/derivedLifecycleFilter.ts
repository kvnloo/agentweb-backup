export type VirtualFilterOperator =
  | 'equals'
  | 'not_equals'
  | 'is_empty'
  | 'is_not_empty';

export interface VirtualLifecycleFilter {
  operator: VirtualFilterOperator;
  value?: string;
}

/**
 * Finding A11a: lifecycle is a total semantic field, so storage absence is never
 * semantic emptiness. Equality is deliberately NOT resolved here because a lead row
 * alone lacks the authoritative user/activity/deal signals.
 */
export function matchesLifecyclePresenceFilter(
  filter: VirtualLifecycleFilter,
): boolean | undefined {
  if (filter.operator === 'is_empty') return false;
  if (filter.operator === 'is_not_empty') return true;
  return undefined;
}
