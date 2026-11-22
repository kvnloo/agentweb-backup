/**
 * ENG-2368 (child of ENG-2167): pure drip-sequence step evaluator.
 *
 * Decides the next action for one lead enrolled in a drip sequence. No
 * persistence, network, or sender calls — callers own enrollment storage,
 * sending, and moving completed leads to the newsletter segment.
 */

export interface SequenceStep {
  /** Delay before this step, measured from the previous step's send (step 0: from enrollment). */
  delayMs: number;
}

export interface SequenceDefinition {
  steps: SequenceStep[];
  /** Quiet window after the last step's send before the sequence completes with no response. */
  quietWindowMs: number;
}

export interface SequenceEnrollment {
  enrolledAt: number;
}

export type StopReason = 'replied' | 'booked' | 'unsubscribed' | 'bounced';

export type SequenceEvent =
  | { type: 'sent'; stepIndex: number; at: number }
  | { type: StopReason; at: number };

export type SequenceAction =
  | { type: 'send'; stepIndex: number; dueAt: number }
  | { type: 'wait'; until: number }
  | { type: 'stop'; reason: StopReason }
  | { type: 'complete'; outcome: 'no_response' };

const STOP_REASONS: ReadonlySet<string> = new Set<StopReason>(['replied', 'booked', 'unsubscribed', 'bounced']);

export function nextSequenceAction(
  definition: SequenceDefinition,
  enrollment: SequenceEnrollment,
  events: readonly SequenceEvent[],
  now: number,
): SequenceAction {
  // Stop events count only once they have happened by `now`; a recorded send always
  // dedups its step regardless of timestamp (clock skew must not cause a re-send).
  // Order of the input array is irrelevant.
  const past = events.filter((e) => e.type === 'sent' || e.at <= now);

  // AC2: the earliest stop event wins and takes precedence over any due send.
  let earliestStop: { reason: StopReason; at: number } | undefined;
  for (const e of past) {
    if (STOP_REASONS.has(e.type) && (!earliestStop || e.at < earliestStop.at)) {
      earliestStop = { reason: e.type as StopReason, at: e.at };
    }
  }
  if (earliestStop) return { type: 'stop', reason: earliestStop.reason };

  // AC4: dedup sends by stepIndex; keep the first recorded send time per step.
  const sentAt = new Map<number, number>();
  for (const e of past) {
    if (e.type === 'sent') {
      const prev = sentAt.get(e.stepIndex);
      if (prev === undefined || e.at < prev) sentAt.set(e.stepIndex, e.at);
    }
  }

  const { steps } = definition;
  // AC1: steps fire strictly in order — the next step is the first unsent index.
  let next = 0;
  while (next < steps.length && sentAt.has(next)) next++;

  if (next >= steps.length) {
    if (steps.length === 0) return { type: 'complete', outcome: 'no_response' };
    const lastSent = sentAt.get(steps.length - 1)!;
    const completeAt = lastSent + definition.quietWindowMs;
    return now >= completeAt ? { type: 'complete', outcome: 'no_response' } : { type: 'wait', until: completeAt };
  }

  const base = next === 0 ? enrollment.enrolledAt : sentAt.get(next - 1)!;
  const dueAt = base + steps[next].delayMs;
  return now >= dueAt ? { type: 'send', stepIndex: next, dueAt } : { type: 'wait', until: dueAt };
}
