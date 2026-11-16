/**
 * ENG-2534 (child of ENG-2167): pure enrollment-trigger matcher for drip sequences.
 *
 * Given a lead event (lead created / tag added) and the org's sequences, decide which
 * sequences the lead should be enrolled in, with a skip reason for every other sequence.
 * No I/O, persistence, or sending — the caller owns enrollment writes.
 */

export type TriggerEventType = 'lead_created' | 'tag_added';
export type TriggerSource = 'crm' | 'webhook' | 'csv';
export type SequenceStatus = 'active' | 'paused' | 'draft';

export interface TriggerEvent {
  type: TriggerEventType;
  leadId: string;
  tag?: string;
  source: TriggerSource;
}

export interface SequenceTrigger {
  type: TriggerEventType;
  tag?: string;
  sources?: TriggerSource[];
}

export interface TriggerSequence {
  id: string;
  status: SequenceStatus;
  trigger: SequenceTrigger;
}

export interface ExistingEnrollment {
  leadId: string;
  sequenceId: string;
  status: string;
}

export type TriggerSkipReason =
  | 'not_active'
  | 'event_type_mismatch'
  | 'tag_mismatch'
  | 'source_mismatch'
  | 'already_enrolled';

export interface TriggerSkip {
  sequenceId: string;
  reason: TriggerSkipReason;
}

export interface TriggerMatchResult {
  enroll: string[];
  skipped: TriggerSkip[];
}

const BLOCKING_ENROLLMENT_STATUSES = new Set(['active', 'completed']);

function normalizeTag(tag: string | undefined): string {
  return (tag ?? '').trim().toLowerCase();
}

function skipReason(
  event: TriggerEvent,
  sequence: TriggerSequence,
  enrolled: Set<string>,
): TriggerSkipReason | null {
  if (sequence.status !== 'active') return 'not_active';
  const trigger = sequence.trigger;
  if (trigger.type !== event.type) return 'event_type_mismatch';
  if (trigger.type === 'tag_added') {
    const wanted = normalizeTag(trigger.tag);
    if (!wanted || wanted !== normalizeTag(event.tag)) return 'tag_mismatch';
  }
  if (trigger.sources && trigger.sources.length > 0 && !trigger.sources.includes(event.source)) {
    return 'source_mismatch';
  }
  if (enrolled.has(sequence.id)) return 'already_enrolled';
  return null;
}

export function matchEnrollmentTriggers(
  event: TriggerEvent,
  sequences: readonly TriggerSequence[],
  existingEnrollments: readonly ExistingEnrollment[] = [],
): TriggerMatchResult {
  const enrolled = new Set(
    existingEnrollments
      .filter(
        (e) => e.leadId === event.leadId && BLOCKING_ENROLLMENT_STATUSES.has(e.status.toLowerCase()),
      )
      .map((e) => e.sequenceId),
  );

  const ordered = [...sequences].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const result: TriggerMatchResult = { enroll: [], skipped: [] };
  const seen = new Set<string>();

  for (const sequence of ordered) {
    if (seen.has(sequence.id)) continue;
    seen.add(sequence.id);
    const reason = skipReason(event, sequence, enrolled);
    if (reason) result.skipped.push({ sequenceId: sequence.id, reason });
    else result.enroll.push(sequence.id);
  }
  return result;
}
