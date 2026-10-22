/**
 * ENG-2537 (child of ENG-2167): pure drip-sequence definition validator.
 *
 * Checks a draft sequence before it is saved/enrolled and collects every error
 * (never stops at the first). No I/O, storage, or enrollment.
 */
import { DEFAULT_DRIP_MERGE_FIELDS } from './dripSequenceMergeFields';

export const SUPPORTED_DRIP_CHANNELS = ['email'] as const;
export type DripChannel = (typeof SUPPORTED_DRIP_CHANNELS)[number];

/** Default upper bound on a single step delay: 90 days, in minutes. */
export const DEFAULT_MAX_DELAY_MINUTES = 90 * 24 * 60;

export interface DripStepDefinition {
  id: string;
  channel: string;
  /** Minutes after the previous step (or enrollment, for step 0). */
  delayMinutes: number;
  subject?: string;
  html?: string;
  text?: string;
}

export interface DripSequenceDefinition {
  steps: readonly DripStepDefinition[];
}

export type SequenceErrorCode =
  | 'empty_sequence'
  | 'missing_step_id'
  | 'duplicate_step_id'
  | 'invalid_delay'
  | 'delay_exceeds_max'
  | 'unknown_channel'
  | 'missing_subject'
  | 'missing_body'
  | 'unknown_merge_field';

export interface SequenceValidationError {
  /** Index of the offending step, or null for sequence-level errors. */
  stepIndex: number | null;
  code: SequenceErrorCode;
  message: string;
}

export interface ValidateSequenceOptions {
  maxDelayMinutes?: number;
  knownFields?: readonly string[];
}

export interface SequenceValidationResult {
  ok: boolean;
  errors: SequenceValidationError[];
}

// Same token grammar as the ENG-2535 renderer: {{field}} or {{field|fallback}}.
const TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\|[^}]*)?\}\}/g;

function isBlank(v: unknown): boolean {
  return typeof v !== 'string' || v.trim() === '';
}

export function validateSequenceDefinition(
  def: DripSequenceDefinition,
  opts: ValidateSequenceOptions = {},
): SequenceValidationResult {
  const maxDelay = opts.maxDelayMinutes ?? DEFAULT_MAX_DELAY_MINUTES;
  const known = new Set(opts.knownFields ?? DEFAULT_DRIP_MERGE_FIELDS);
  const errors: SequenceValidationError[] = [];
  const steps = Array.isArray(def?.steps) ? def.steps : [];

  if (steps.length === 0) {
    errors.push({ stepIndex: null, code: 'empty_sequence', message: 'sequence must have at least one step' });
    return { ok: false, errors };
  }

  const seenIds = new Map<string, number>();
  steps.forEach((step, i) => {
    const push = (code: SequenceErrorCode, message: string) => errors.push({ stepIndex: i, code, message });

    if (isBlank(step.id)) {
      push('missing_step_id', 'step id is required');
    } else if (seenIds.has(step.id)) {
      push('duplicate_step_id', `step id "${step.id}" duplicates step ${seenIds.get(step.id)}`);
    } else {
      seenIds.set(step.id, i);
    }

    if (!Number.isInteger(step.delayMinutes) || step.delayMinutes < 0) {
      push('invalid_delay', `delayMinutes must be a non-negative integer (got ${String(step.delayMinutes)})`);
    } else if (step.delayMinutes > maxDelay) {
      push('delay_exceeds_max', `delayMinutes ${step.delayMinutes} exceeds max ${maxDelay}`);
    }

    if (!(SUPPORTED_DRIP_CHANNELS as readonly string[]).includes(step.channel)) {
      push('unknown_channel', `channel "${String(step.channel)}" is not supported`);
      return;
    }

    if (isBlank(step.subject)) push('missing_subject', 'email step requires a subject');
    if (isBlank(step.html) && isBlank(step.text)) push('missing_body', 'email step requires an html or text body');

    const unknown = new Set<string>();
    for (const part of [step.subject, step.html, step.text]) {
      if (typeof part !== 'string') continue;
      for (const m of part.matchAll(TOKEN_RE)) if (!known.has(m[1])) unknown.add(m[1]);
    }
    for (const field of unknown) push('unknown_merge_field', `merge field "${field}" is not supported`);
  });

  return { ok: errors.length === 0, errors };
}
