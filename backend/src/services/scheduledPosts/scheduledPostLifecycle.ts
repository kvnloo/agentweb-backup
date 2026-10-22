/**
 * ENG-2508 (slice of ENG-2501): pure due-post selection and lifecycle transitions
 * for scheduled social posts. Operates on in-memory records only — no persistence,
 * scheduler wiring, or publishing (gated on the parent's Requires: Me decision).
 */

export type ScheduledPostStatus = 'pending' | 'fired' | 'cancelled' | 'failed';

/** ENG-2519: total publish attempts before a retryable failure becomes terminal. */
export const MAX_ATTEMPTS = 3;

/** Backoff before retry N (1-based): 1m, 5m, 25m, ... */
export function retryBackoffMs(attempt: number): number {
  return 60_000 * 5 ** Math.max(0, attempt - 1);
}

export interface ScheduledPostRecord {
  id: string;
  status: ScheduledPostStatus;
  publishAt: Date;
  content: string;
  mediaUrls: string[];
  firedAt?: Date;
  cancelledAt?: Date;
  updatedAt?: Date;
  failedAt?: Date;
  /** Failed publish attempts so far (ENG-2519); absent means 0. */
  attempts?: number;
  lastError?: string;
}

export type ScheduledPostAction =
  | { type: 'edit'; now: Date; changes: Partial<Pick<ScheduledPostRecord, 'publishAt' | 'content' | 'mediaUrls'>> }
  | { type: 'cancel'; now: Date }
  | { type: 'markFired'; now: Date }
  | { type: 'markAttemptFailed'; now: Date; error: string; retryable: boolean };

export type TransitionErrorCode = 'NOT_PENDING' | 'ALREADY_DUE' | 'EDIT_PUBLISH_AT_NOT_FUTURE';

export type TransitionResult =
  | { ok: true; record: ScheduledPostRecord; changed: boolean }
  | { ok: false; code: TransitionErrorCode; message: string };

/** Pending records with publishAt <= now, oldest first. Input is not mutated. */
export function selectDuePosts(records: readonly ScheduledPostRecord[], now: Date): ScheduledPostRecord[] {
  const nowMs = now.getTime();
  return records
    .filter((r) => r.status === 'pending' && r.publishAt.getTime() <= nowMs)
    .sort((a, b) => a.publishAt.getTime() - b.publishAt.getTime() || a.id.localeCompare(b.id));
}

function isDue(record: ScheduledPostRecord, now: Date): boolean {
  return record.publishAt.getTime() <= now.getTime();
}

export function transition(record: ScheduledPostRecord, action: ScheduledPostAction): TransitionResult {
  switch (action.type) {
    case 'edit': {
      if (record.status !== 'pending') {
        return { ok: false, code: 'NOT_PENDING', message: `Cannot edit a ${record.status} post.` };
      }
      if (isDue(record, action.now)) {
        return { ok: false, code: 'ALREADY_DUE', message: 'Post is already due; it can no longer be edited.' };
      }
      const next = { ...record, ...action.changes, updatedAt: action.now };
      if (next.publishAt.getTime() <= action.now.getTime()) {
        return { ok: false, code: 'EDIT_PUBLISH_AT_NOT_FUTURE', message: 'Edited publishAt must be in the future.' };
      }
      return { ok: true, record: next, changed: true };
    }
    case 'cancel': {
      if (record.status !== 'pending') {
        return { ok: false, code: 'NOT_PENDING', message: `Cannot cancel a ${record.status} post.` };
      }
      return { ok: true, record: { ...record, status: 'cancelled', cancelledAt: action.now, updatedAt: action.now }, changed: true };
    }
    case 'markFired': {
      if (record.status === 'fired') {
        // Idempotent: a retried fire acknowledgement is a no-op.
        return { ok: true, record, changed: false };
      }
      if (record.status !== 'pending') {
        return { ok: false, code: 'NOT_PENDING', message: `Cannot fire a ${record.status} post.` };
      }
      return { ok: true, record: { ...record, status: 'fired', firedAt: action.now, updatedAt: action.now }, changed: true };
    }
    case 'markAttemptFailed': {
      if (record.status !== 'pending') {
        return { ok: false, code: 'NOT_PENDING', message: `Cannot record a failed attempt on a ${record.status} post.` };
      }
      const attempts = (record.attempts ?? 0) + 1;
      const common = { ...record, attempts, lastError: action.error, updatedAt: action.now };
      if (action.retryable && attempts < MAX_ATTEMPTS) {
        const publishAt = new Date(action.now.getTime() + retryBackoffMs(attempts));
        return { ok: true, record: { ...common, publishAt }, changed: true };
      }
      return { ok: true, record: { ...common, status: 'failed', failedAt: action.now }, changed: true };
    }
  }
}
