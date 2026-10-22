/**
 * Blind human labelling (ENG-2502). A golden case whose notes start with `[AI-LABEL]` carries an
 * AI-written label. The labelling pages show such a case as unlabelled, with no stored labels, notes
 * or draft suggestions, so a human reviewer never sees the AI's answer first. Saving replaces the
 * AI label, as before. Keep the prefix in step with `AI_LABEL_NOTE_PREFIX` in
 * backend/src/loops/eval/goldenSet.ts.
 */
export const AI_LABEL_NOTE_PREFIX = '[AI-LABEL]';

interface BlindableCase {
  labels: Partial<Record<string, string>>;
  notes?: string;
  draft?: unknown;
  labeller?: string;
  labelledAt?: string;
}

export function isAiLabelledCase(c: Pick<BlindableCase, 'notes'>): boolean {
  return typeof c.notes === 'string' && c.notes.startsWith(AI_LABEL_NOTE_PREFIX);
}

/**
 * The case as a human reviewer should see it: AI-written labels, notes, draft, and who/when
 * labelled it removed. `version` is kept: the save needs it for the optimistic-concurrency check.
 */
export function blindForHuman<T extends BlindableCase>(c: T): T {
  if (!isAiLabelledCase(c)) return c;
  const { draft: _draft, labeller: _labeller, labelledAt: _labelledAt, ...rest } = c;
  return { ...rest, labels: {}, notes: '' } as T;
}

/**
 * A case as returned by a save: the AI draft is dropped so it cannot appear right after the human's
 * labels are stored (the backend keeps `draft` on the record; it is not part of the label).
 */
export function withoutDraft<T extends object>(c: T): T {
  if (!('draft' in c)) return c;
  const { draft: _draft, ...rest } = c as T & { draft?: unknown };
  return rest as T;
}
