import type { WorkPlan, WorkPlanDisplayCategory } from './workPlanService';

export interface CustomerWorkPlanProjection {
  id: string;
  title: string;
  summary: string;
  categories: WorkPlanDisplayCategory[];
  channel?: string;
  suite?: { id: string; name: string; position: number };
  steps: Array<{ position: number; label: string }>;
  nextPlanIds: string[];
  visibility: WorkPlan['visibility'];
}

const LEGACY_CATEGORY: Record<string, WorkPlanDisplayCategory> = {
  Strategy: 'strategy', 'Paid Ads': 'paid-ads', Content: 'content',
};

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** A deliberately shallow, safe projection: never leak execution instructions. */
export function projectWorkPlanForCustomer(plan: unknown): CustomerWorkPlanProjection | null {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null;
  const value = plan as WorkPlan;
  if (typeof value.planId !== 'string' || !value.planId || typeof value.title !== 'string' || !Array.isArray(value.steps)) return null;
  const display = value.display;
  const categories = display?.categories?.length ? display.categories : (LEGACY_CATEGORY[value.category || ''] ? [LEGACY_CATEGORY[value.category || '']] : []);
  return {
    id: value.planId,
    title: text(display?.title, 80) || value.title,
    summary: text(display?.summary, 180) || text(value.description, 180),
    categories,
    ...(display?.channel && { channel: display.channel }),
    ...(display?.suite && { suite: display.suite }),
    steps: value.steps.flatMap((step, index) => (
      step && typeof step.title === 'string'
        ? [{ position: index + 1, label: text(display?.stepLabels?.[index], 80) || step.title }]
        : []
    )),
    nextPlanIds: display?.nextPlanIds || [],
    visibility: value.visibility,
  };
}
