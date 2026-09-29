import {
  computeLifecycle,
  type LifecycleSignals,
  type LifecycleStage,
} from '../services/lifecycleService';

export type VirtualFilterOperator =
  | 'equals'
  | 'not_equals'
  | 'is_empty'
  | 'is_not_empty';

export interface LifecycleFilterLead extends LifecycleSignals {
  lifecycle?: LifecycleStage | null;
}

export interface VirtualLifecycleFilter {
  operator: VirtualFilterOperator;
  value?: LifecycleStage;
}

export function derivedLifecycleValue(
  lead: LifecycleFilterLead,
  now: Date = new Date(),
): LifecycleStage {
  return computeLifecycle(
    {
      ...lead,
      currentLifecycle: lead.lifecycle ?? lead.currentLifecycle,
    },
    now,
  );
}

export function matchesDerivedLifecycleFilter(
  lead: LifecycleFilterLead,
  filter: VirtualLifecycleFilter,
  now: Date = new Date(),
): boolean {
  const lifecycle = derivedLifecycleValue(lead, now);

  switch (filter.operator) {
    case 'equals':
      return lifecycle === filter.value;
    case 'not_equals':
      return lifecycle !== filter.value;
    case 'is_empty':
      // Lifecycle is a total derived function: every lead resolves to a stage,
      // including 'unknown'. Persisted attribute absence is not semantic emptiness.
      return false;
    case 'is_not_empty':
      return true;
  }
}
