import type {
  WorkPlanDisplayCategory,
  WorkPlanDisplayChannel,
  WorkPlanDisplayMetadataV1,
} from './workPlanService';

const CATEGORIES = new Set<WorkPlanDisplayCategory>(['strategy', 'paid-ads', 'founder-led-sales', 'event-led-sales', 'content']);
const CHANNELS = new Set<WorkPlanDisplayChannel>(['meta', 'google', 'linkedin', 'email', 'event', 'content', 'cross-channel']);
const CONTROL = /[\u0000-\u001F\u007F]/;
const SUITE_ID = /^[a-z0-9-]{1,64}$/;

function optionalText(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > max || CONTROL.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

/**
 * Validate every nested element at the admin boundary, then return a compact value.
 *
 * @param ownPlanId the plan's own id, used only to reject a self-referencing
 *   `nextPlanIds` entry. Omit at create time, when the plan has no id yet —
 *   a caller cannot reference an id that does not exist, so there is nothing
 *   to compare against.
 */
export function normalizeWorkPlanDisplayMetadata(value: unknown, stepCount: number, ownPlanId?: string): WorkPlanDisplayMetadataV1 | undefined {
  if (value === undefined) return undefined;
  if (value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('display must be an object');
  const input = value as Record<string, unknown>;
  if (input.version !== 1) throw new Error('display.version must be 1');

  const categories = input.categories === undefined ? undefined : (() => {
    if (!Array.isArray(input.categories) || input.categories.length > 5) throw new Error('display.categories is invalid');
    if (!input.categories.every((item): item is WorkPlanDisplayCategory => typeof item === 'string' && CATEGORIES.has(item as WorkPlanDisplayCategory))) throw new Error('display.categories is invalid');
    if (new Set(input.categories).size !== input.categories.length) throw new Error('display.categories must be unique');
    return input.categories;
  })();
  const channel = input.channel === undefined || input.channel === null || input.channel === '' ? undefined : (() => {
    if (typeof input.channel !== 'string' || !CHANNELS.has(input.channel as WorkPlanDisplayChannel)) throw new Error('display.channel is invalid');
    return input.channel as WorkPlanDisplayChannel;
  })();
  const stepLabels = input.stepLabels === undefined ? undefined : (() => {
    if (!Array.isArray(input.stepLabels) || input.stepLabels.length > stepCount) throw new Error('display.stepLabels is invalid');
    return input.stepLabels.map((label, index) => optionalText(label, `display.stepLabels[${index}]`, 80) ?? (() => { throw new Error('display.stepLabels is invalid'); })());
  })();
  const nextPlanIds = input.nextPlanIds === undefined ? undefined : (() => {
    if (!Array.isArray(input.nextPlanIds) || input.nextPlanIds.length > 3) throw new Error('display.nextPlanIds is invalid');
    const ids = input.nextPlanIds.map((id, index) => optionalText(id, `display.nextPlanIds[${index}]`, 128) ?? (() => { throw new Error('display.nextPlanIds is invalid'); })());
    if (new Set(ids).size !== ids.length) throw new Error('display.nextPlanIds must be unique');
    if (ownPlanId && ids.includes(ownPlanId)) throw new Error('display.nextPlanIds must not reference the plan itself');
    return ids;
  })();
  let suite: WorkPlanDisplayMetadataV1['suite'];
  if (input.suite !== undefined && input.suite !== null) {
    if (!input.suite || typeof input.suite !== 'object' || Array.isArray(input.suite)) throw new Error('display.suite is invalid');
    const candidate = input.suite as Record<string, unknown>;
    const id = optionalText(candidate.id, 'display.suite.id', 64);
    const name = optionalText(candidate.name, 'display.suite.name', 80);
    if (!id || !name || !SUITE_ID.test(id) || !Number.isInteger(candidate.position) || (candidate.position as number) < 1 || (candidate.position as number) > 99) throw new Error('display.suite is invalid');
    suite = { id, name, position: candidate.position as number };
  }
  return {
    version: 1,
    ...(optionalText(input.title, 'display.title', 80) && { title: optionalText(input.title, 'display.title', 80) }),
    ...(optionalText(input.summary, 'display.summary', 180) && { summary: optionalText(input.summary, 'display.summary', 180) }),
    ...(categories?.length && { categories }), ...(channel && { channel }), ...(suite && { suite }),
    ...(stepLabels?.length && { stepLabels }), ...(nextPlanIds?.length && { nextPlanIds }),
  };
}
