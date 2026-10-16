/**
 * ENG-2508 (slice of ENG-2501): pure due-post selection and lifecycle transitions
 * for scheduled social posts. Operates on in-memory records only — no persistence,
 * scheduler wiring, or publishing (gated on the parent's Requires: Me decision).
 */

export type ScheduledPostStatus = 'pending' | 'fired' | 'cancelled';

export interface ScheduledPostRecord {
  id: string;
  status: ScheduledPostStatus;
  publishAt: Date;
  content: string;
  mediaUrls: string[];
  firedAt?: Date;
  cancelledAt?: Date;
  updatedAt?: Date;
}

export type ScheduledPostAction =
  | { type: 'edit'; now: Date; changes: Partial<Pick<ScheduledPostRecord, 'publishAt' | 'content' | 'mediaUrls'>> }
  | { type: 'cancel'; now: Date }
  | { type: 'markFired'; now: Date };

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
  }
}
