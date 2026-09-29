import { computeLifecycle, type LifecycleSignals, type LifecycleStage } from '../services/lifecycleService';

export interface LifecycleExperimentLead extends LifecycleSignals {
  storedLifecycle?: LifecycleStage | null;
}

export interface LifecycleModelComparison {
  storedModel: LifecycleStage;
  derivedModel: LifecycleStage;
  diverged: boolean;
  persistedEmpty: boolean;
  derivedEmpty: boolean;
}

export function compareLifecycleModels(
  lead: LifecycleExperimentLead,
  now: Date = new Date(),
): LifecycleModelComparison {
  const storedModel = lead.storedLifecycle ?? computeLifecycle(lead, now);
  const derivedModel = computeLifecycle(
    {
      ...lead,
      currentLifecycle: lead.storedLifecycle ?? lead.currentLifecycle,
    },
    now,
  );

  return {
    storedModel,
    derivedModel,
    diverged: storedModel !== derivedModel,
    persistedEmpty: lead.storedLifecycle == null,
    derivedEmpty: false,
  };
}

export function staleClassificationRate(
  leads: LifecycleExperimentLead[],
  now: Date = new Date(),
): number {
  if (leads.length === 0) return 0;
  const stale = leads.filter((lead) => compareLifecycleModels(lead, now).diverged).length;
  return stale / leads.length;
}
