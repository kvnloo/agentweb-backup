/**
 * ENG-2936: same-email re-submits on the public forward-lead route merged into one lead but
 * REPLACED the earlier submission's notes and conflicting customFields ("Requested Book a Demo"
 * lost to "Completed Bad Hire Calculator"; team_size "Up to 50" lost to "10").
 *
 * The lead row stays the single contact record. These pure helpers keep both submissions:
 *  - notes are appended, never replaced;
 *  - a non-empty value about to be overwritten with a different one is captured so the
 *    per-submission history entry (AW-ContactEvents `form.submitted`) records what it was.
 */

export const NOTES_SEPARATOR = '\n\n';

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

/**
 * Upper bound on the merged notes string. DynamoDB caps an item at 400 KB; unbounded appends
 * made a long-lived lead reject every new submission with a 500 (Opslane, PR #3979). The full
 * text of every submission is still recorded on its AW-ContactEvents `form.submitted` entry, so
 * the lead row keeps the most recent notes and drops the oldest blocks first.
 */
export const MAX_NOTES_CHARS = 50_000;

/** True when `block` already appears in `notes` as a whole blank-line-bounded block. */
function containsBlock(notes: string, block: string): boolean {
  let from = 0;
  for (;;) {
    const i = notes.indexOf(block, from);
    if (i < 0) return false;
    const end = i + block.length;
    const startOk = i === 0 || notes.slice(Math.max(0, i - NOTES_SEPARATOR.length), i) === NOTES_SEPARATOR;
    const endOk = end === notes.length || notes.slice(end, end + NOTES_SEPARATOR.length) === NOTES_SEPARATOR;
    if (startOk && endOk) return true;
    from = i + 1;
  }
}

function capNotes(notes: string): string {
  if (notes.length <= MAX_NOTES_CHARS) return notes;
  const blocks = notes.split(NOTES_SEPARATOR);
  let length = notes.length;
  let first = 0;
  while (blocks.length - first > 1 && length > MAX_NOTES_CHARS) {
    length -= blocks[first].length + NOTES_SEPARATOR.length;
    first++;
  }
  const kept = blocks.slice(first).join(NOTES_SEPARATOR);
  return kept.length <= MAX_NOTES_CHARS ? kept : kept.slice(0, MAX_NOTES_CHARS);
}

/** Append `incoming` to `existing` unless it is empty or already present; bounded in size. */
export function appendNotes(existing: unknown, incoming: unknown): string {
  const prev = str(existing);
  const next = str(incoming);
  if (!next) return capNotes(prev);
  if (!prev) return capNotes(next);
  if (prev === next || containsBlock(prev, next)) return prev;
  return capNotes(`${prev}${NOTES_SEPARATOR}${next}`);
}

/**
 * Non-empty prior values that `updates` overwrites with a DIFFERENT value. Standard fields are
 * keyed by name; customFields keys are prefixed `customFields.`. Notes are excluded because
 * they append rather than overwrite.
 */
export function collectOverwrittenValues(
  existingLead: Record<string, any>,
  updates: Record<string, any>,
): Record<string, unknown> {
  const prior: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(updates)) {
    if (field === 'customFields' || field === 'notes') continue;
    const before = existingLead[field];
    if (str(before) && typeof value !== 'object' && str(before) !== str(value)) prior[field] = before;
  }
  const beforeCf = existingLead.customFields || {};
  const afterCf = updates.customFields || {};
  for (const [key, value] of Object.entries(afterCf)) {
    if (!Object.prototype.hasOwnProperty.call(beforeCf, key)) continue;
    const before = beforeCf[key];
    if (before === null || before === undefined || before === '') continue;
    if (JSON.stringify(before) !== JSON.stringify(value)) prior[`customFields.${key}`] = before;
  }
  return prior;
}

/**
 * Attempts for one guarded notes merge. The writer that loses every round needs one attempt
 * per competitor, so five attempts could not absorb a six-way burst: measured on Dev-AW-Leads,
 * one of six concurrent appends ran out of attempts in 4 of 6 runs.
 */
export const NOTES_GUARD_MAX_ATTEMPTS = 8;
const NOTES_GUARD_BASE_DELAY_MS = 25;
const NOTES_GUARD_MAX_DELAY_MS = 400;

const isLostNotesGuard = (err: any): boolean =>
  err?.code === 'ConditionalCheckFailedException' || err?.name === 'ConditionalCheckFailedException';

/**
 * Run `mergeOnce` against `initial`; when its notes compare-and-set loses to a concurrent
 * writer, wait a jittered moment, re-read the row and merge again. Any other error, and a
 * lost guard on the last attempt, is rethrown. The wait is full jitter over a doubling
 * ceiling so the losers of one round do not all retry at the same instant.
 */
export async function mergeWithNotesRetry<T>(
  initial: T,
  mergeOnce: (current: T) => Promise<void>,
  reread: (current: T) => Promise<T | null | undefined>,
  opts: { sleep?: (ms: number) => Promise<void>; random?: () => number } = {},
): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = opts.random ?? Math.random;
  let current = initial;
  for (let attempt = 1; ; attempt++) {
    try {
      await mergeOnce(current);
      return;
    } catch (err) {
      if (!isLostNotesGuard(err) || attempt >= NOTES_GUARD_MAX_ATTEMPTS) throw err;
      const ceiling = Math.min(NOTES_GUARD_MAX_DELAY_MS, NOTES_GUARD_BASE_DELAY_MS * 2 ** (attempt - 1));
      await sleep(Math.floor(random() * ceiling));
      current = (await reread(current)) || current;
    }
  }
}
