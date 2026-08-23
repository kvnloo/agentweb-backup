import type { WorkPlan, WorkPlanDisplayCategory, WorkPlanDisplayChannel } from './workPlanService';
import { CATEGORIES, CHANNELS, SUITE_ID } from './workPlanDisplayMetadata';

export interface CustomerWorkPlanProjection {
  id: string;
  title: string;
  summary: string;
  categories: WorkPlanDisplayCategory[];
  channel?: WorkPlanDisplayChannel;
  suite?: { id: string; name: string; position: number };
  steps: Array<{ position: number; label: string }>;
  nextPlanIds: string[];
  thumbnail?: { url: string; alt: string };
  visibility: WorkPlan['visibility'];
}

const LEGACY_CATEGORY: Record<string, WorkPlanDisplayCategory> = {
  Strategy: 'strategy', 'Paid Ads': 'paid-ads', Content: 'content',
};

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** Malformed optional metadata is ignored field-by-field and falls back — never
 * re-exposed as-is, since a downstream consumer (this projection's whole
 * purpose) trusts these arrays/enums to be shaped correctly. */
function validCategories(value: unknown): WorkPlanDisplayCategory[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.every((item): item is WorkPlanDisplayCategory => typeof item === 'string' && CATEGORIES.has(item as WorkPlanDisplayCategory))
    ? (value as WorkPlanDisplayCategory[])
    : null;
}

function validChannel(value: unknown): WorkPlanDisplayChannel | undefined {
  return typeof value === 'string' && CHANNELS.has(value as WorkPlanDisplayChannel) ? (value as WorkPlanDisplayChannel) : undefined;
}

function validSuite(value: unknown): { id: string; name: string; position: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== 'string' || !SUITE_ID.test(candidate.id)
    || typeof candidate.name !== 'string' || !candidate.name.trim()
    || !Number.isInteger(candidate.position) || (candidate.position as number) < 1 || (candidate.position as number) > 99
  ) return undefined;
  return { id: candidate.id, name: candidate.name, position: candidate.position as number };
}

function validNextPlanIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function validThumbnail(value: WorkPlan): { url: string; alt: string } | undefined {
  const url = typeof value.thumbnail_url === 'string' ? value.thumbnail_url.trim() : '';
  if (!url) return undefined;
  const alt = typeof value.thumbnail_alt_text === 'string' ? value.thumbnail_alt_text.trim() : '';
  return { url, alt };
}

/** A deliberately shallow, safe projection: never leak execution instructions. */
export function projectWorkPlanForCustomer(plan: unknown): CustomerWorkPlanProjection | null {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null;
  const value = plan as WorkPlan;
  if (typeof value.planId !== 'string' || !value.planId || typeof value.title !== 'string' || !Array.isArray(value.steps)) return null;
  const display = value.display;
  const categories = validCategories(display?.categories) || (LEGACY_CATEGORY[value.category || ''] ? [LEGACY_CATEGORY[value.category || '']] : []);
  const channel = validChannel(display?.channel);
  const suite = validSuite(display?.suite);
  const thumbnail = validThumbnail(value);
  return {
    id: value.planId,
    title: text(display?.title, 80) || value.title,
    summary: text(display?.summary, 180) || text(value.description, 180),
    categories,
    ...(channel && { channel }),
    ...(suite && { suite }),
    steps: value.steps.filter((step) => step && typeof step.title === 'string').map((step, index) => ({
      position: index + 1,
      label: text(display?.stepLabels?.[index], 80) || step.title,
    })),
    nextPlanIds: validNextPlanIds(display?.nextPlanIds),
    ...(thumbnail && { thumbnail }),
    visibility: value.visibility,
  };
}
