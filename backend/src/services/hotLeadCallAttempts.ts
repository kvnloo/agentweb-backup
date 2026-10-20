import type { HotLeadCallRecord } from './voice/leadCallStore.types';

export type NextAttemptRefusal = 'max_attempts' | 'too_old' | 'no_candidates' | 'disabled';

export interface NextAttemptDecision {
  enqueued: boolean;
  /** Why no further attempt was queued; absent when enqueued. */
  reason?: NextAttemptRefusal;
}

/**
 * Asks whether another team member should be called for this lead after the current member's attempt
 * ended without a bridge, and queues the next attempt if so. The voice webhooks call it after they have
 * metered the finished attempt and moved the record to `between_attempts`; when it answers
 * `enqueued: false` they finish the record. Webhooks never place calls themselves.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- placeholder until the orchestrator implements attempts
export async function requestNextHotLeadCallAttempt(_args: {
  listId: string;
  leadId: string;
  record: HotLeadCallRecord;
}): Promise<NextAttemptDecision> {
  return { enqueued: false, reason: 'no_candidates' };
}
