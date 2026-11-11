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

/** Append `incoming` to `existing` unless it is empty or already present. */
export function appendNotes(existing: unknown, incoming: unknown): string {
  const prev = str(existing);
  const next = str(incoming);
  if (!next) return prev;
  if (!prev) return next;
  if (prev === next || prev.split(NOTES_SEPARATOR).includes(next)) return prev;
  return `${prev}${NOTES_SEPARATOR}${next}`;
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
