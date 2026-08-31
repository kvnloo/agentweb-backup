/**
 * DynamoDB item-size budgeting (ENG-1048).
 *
 * DynamoDB caps a single item at 400 KB, and `AW-TaskSchedules` rows grow without
 * bound along two axes: `promptRevisions` (a FULL snapshot of the prompt on every
 * edit) and `runResults`. A schedule whose starting message is ~35k characters
 * therefore drifts into the ceiling — the row behind ENG-1048 sat at 408,560 of
 * the 409,600 allowed bytes, of which 334 KB was revision history. Past that
 * point EVERY write fails with `ValidationException: Item size has exceeded the
 * maximum allowed size`, which surfaced to the caller as a bare
 * `500 Failed to update scheduled chat` — with no hint that history, not the
 * payload, was the problem (trimming the prompt did not help, because the
 * revision churn alone added ~6.6 KB per edit).
 *
 * These helpers let a write path budget the projected item BEFORE sending it and
 * shed the oldest entries of a growable list to stay under the ceiling.
 */

/** DynamoDB's hard per-item limit. */
export const DYNAMO_MAX_ITEM_BYTES = 400 * 1024;

/**
 * Working budget for schedule items. Deliberately below the hard limit: our size
 * estimate is an approximation, and concurrent writers (a run appending to
 * `runResults` while the owner edits the prompt) must not tip the item over.
 */
export const SCHEDULE_ITEM_BUDGET_BYTES = 380 * 1024;

/**
 * The most run results a single write can shed alongside an edit and stay inside
 * DynamoDB's 4 KB `UpdateExpression` limit — each dropped entry is named by index.
 * The shed has to ride the edit's own write (deleting history first and then failing
 * the edit would cost the owner run history for a save that never happened), so a
 * schedule needing more than this to fit is refused outright instead.
 */
export const MAX_ATOMIC_RUN_RESULT_REMOVALS = 100;

const utf8 = (value: string): number => Buffer.byteLength(value, 'utf8');

/**
 * Approximate the stored size of an attribute value using DynamoDB's documented
 * sizing rules (strings are raw UTF-8 bytes; lists/maps carry a small overhead
 * per container and per element).
 */
const estimateValueBytes = (value: any): number => {
  if (value === null || typeof value === 'boolean') return 1;
  if (typeof value === 'string') return utf8(value);
  if (typeof value === 'number') {
    // ~1 byte per two significant digits, plus one.
    const digits = String(value).replace(/[-.]/g, '').length;
    return Math.ceil(digits / 2) + 1;
  }
  if (Buffer.isBuffer(value)) return value.byteLength;
  if (Array.isArray(value)) {
    return value.reduce<number>((total, element) => total + 1 + estimateValueBytes(element), 3);
  }
  if (typeof value === 'object') {
    return Object.entries(value).reduce<number>((total, [key, nested]) => {
      if (nested === undefined) return total;
      return total + utf8(key) + 1 + estimateValueBytes(nested);
    }, 3);
  }
  return 0;
};

/**
 * Approximate the stored size of a whole item: every attribute name plus its
 * value. `undefined` attributes are skipped — they are never persisted.
 */
export const estimateDynamoItemBytes = (item: Record<string, any>): number =>
  Object.entries(item || {}).reduce<number>((total, [key, value]) => {
    if (value === undefined) return total;
    return total + utf8(key) + estimateValueBytes(value);
  }, 0);

/** True when a DynamoDB error is the 400 KB item-size overflow. */
export const isDynamoItemSizeError = (error: any): boolean => {
  if (!error) return false;
  const name = String(error.code || error.name || '');
  if (name !== 'ValidationException') return false;
  return /item size .*exceeded the maximum allowed size/i.test(String(error.message || ''));
};

/**
 * Shed the OLDEST entries of `list` until `item` (with that list in place at
 * `listKey`) fits `budgetBytes`. Returns the surviving entries — newest kept —
 * and how many were dropped. `kept` is empty when even the single newest entry
 * cannot fit, which the caller should treat as "this write cannot succeed".
 */
export const trimListToItemBudget = <T>(
  item: Record<string, any>,
  listKey: string,
  list: T[],
  budgetBytes: number = SCHEDULE_ITEM_BUDGET_BYTES,
): { kept: T[]; dropped: number } => {
  const entries = Array.isArray(list) ? list : [];
  const { [listKey]: _omitted, ...rest } = item || {};
  let used = estimateDynamoItemBytes(rest) + utf8(listKey) + 3;

  if (used + entries.reduce((total, entry) => total + 1 + estimateValueBytes(entry), 0) <= budgetBytes) {
    return { kept: entries, dropped: 0 };
  }

  // Walk newest → oldest so the most recent entries are the ones that survive.
  const keptReversed: T[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const cost = 1 + estimateValueBytes(entries[i]);
    if (used + cost > budgetBytes) break;
    used += cost;
    keptReversed.push(entries[i]);
  }

  const kept = keptReversed.reverse();
  return { kept, dropped: entries.length - kept.length };
};

/**
 * ENG-1071: read-only diagnosis of WHY a schedule is under storage pressure,
 * for surfaces (Emma, the portal) that only have the failure symptom — a bare
 * `500`/`400` — and no way to see which field is actually consuming the
 * item's budget. This is deliberately read-only: it reports byte counts, it
 * never trims, prunes, or writes anything (that stays ENG-1048's job, on the
 * write path above).
 */
export type ScheduleStorageField = 'currentPrompt' | 'promptRevisions' | 'runResults' | 'other';

export interface ScheduleStorageDiagnostics {
  /** Total marshaled item size, same estimator the write path budgets against. */
  totalBytes: number;
  /** DynamoDB's hard per-item ceiling (`DYNAMO_MAX_ITEM_BYTES`). */
  limitBytes: number;
  /** The working budget writes are held to (`SCHEDULE_ITEM_BUDGET_BYTES` by default). */
  budgetBytes: number;
  /** Byte contribution of each bounded field — sizes only, never the field's content. */
  fields: {
    currentPrompt: number;
    promptRevisions: number;
    runResults: number;
    other: number;
  };
  /** Which field is consuming the most of the item's budget. */
  dominantField: ScheduleStorageField;
  /** True once `totalBytes` has crossed `budgetBytes`. */
  approachingLimit: boolean;
  /** Recommended next step, or `null` when nothing is needed. Never null when approachingLimit is true. */
  correctiveAction: string | null;
}

const SCHEDULE_STORAGE_FIELD_LABELS: Record<ScheduleStorageField, string> = {
  currentPrompt: 'the current starting message',
  promptRevisions: 'saved prompt-edit history (promptRevisions)',
  runResults: 'saved run history (runResults)',
  other: 'other schedule fields',
};

/** Marshaled size of a single named attribute as it contributes to the item, name + value. */
const fieldBytes = (item: Record<string, any>, key: string): number =>
  estimateDynamoItemBytes({ [key]: item?.[key] });

/**
 * Byte breakdown for the three fields that actually grow without bound
 * (`startingMessage`, `promptRevisions`, `runResults`), the dominant
 * contributor, and — once the schedule has crossed its working budget — the
 * one corrective action a customer can take themselves. Never returns any
 * field's actual content, only sizes: safe to hand to Emma or the portal.
 */
export const getScheduleStorageDiagnostics = (
  schedule: Record<string, any> | null | undefined,
  budgetBytes: number = SCHEDULE_ITEM_BUDGET_BYTES,
): ScheduleStorageDiagnostics => {
  const item = schedule || {};
  const currentPrompt = fieldBytes(item, 'startingMessage');
  const promptRevisions = fieldBytes(item, 'promptRevisions');
  const runResults = fieldBytes(item, 'runResults');
  const totalBytes = estimateDynamoItemBytes(item);
  const other = Math.max(0, totalBytes - currentPrompt - promptRevisions - runResults);

  const fields = { currentPrompt, promptRevisions, runResults, other };
  const dominantField = (Object.keys(fields) as ScheduleStorageField[]).reduce((leader, candidate) =>
    fields[candidate] > fields[leader] ? candidate : leader
  );

  const approachingLimit = totalBytes >= budgetBytes;
  const correctiveAction = approachingLimit
    ? `This schedule is using about ${Math.round(totalBytes / 1024)}KB of DynamoDB's `
      + `${Math.round(DYNAMO_MAX_ITEM_BYTES / 1024)}KB per-item limit, mostly from `
      + `${SCHEDULE_STORAGE_FIELD_LABELS[dominantField]}. AgentWeb automatically trims the oldest `
      + 'saved prompt-revision and run-history entries on every edit to stay under the limit — if '
      + 'edits keep failing anyway, shorten the starting message, since that is the only field you '
      + 'can reduce directly.'
    : null;

  return {
    totalBytes,
    limitBytes: DYNAMO_MAX_ITEM_BYTES,
    budgetBytes,
    fields,
    dominantField,
    approachingLimit,
    correctiveAction,
  };
};
