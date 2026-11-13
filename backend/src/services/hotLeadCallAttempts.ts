import { createHash } from 'crypto';
import type { HotLeadCallConfig } from './hotLeadCallConfig';
import { selectHotLeadCallCandidates } from './hotLeadCallRoster';
import { closeBetweenAttempts, placeMemberCall } from './hotLeadCallPlacement';
import { runQueuedHotLeadJob } from './hotLeadCallQueue';
import { errorText, isNonEmpty, MINUTE_MS } from './hotLeadCallText';
import { resolveHotLeadCallContext, type HotLeadCallContext } from './voice/hotLeadCallContext';
import { isHotLeadCallEntitled } from './voice/hotLeadCallEntitlement';
import { isHotLeadCallEnabled } from './voice/hotLeadCallMode';
import { getLeadCallStore } from './voice/leadCallStore';
import type { HotLeadCallRecord, LeadCallStore } from './voice/leadCallStore.types';

export const NEXT_ATTEMPT_SOURCE = 'hot_lead_call_next';

type NextAttemptRefusal = 'max_attempts' | 'too_old' | 'no_candidates' | 'disabled';

type NextAttemptDecision =
  | { enqueued: true }
  /** `reason` is why no further attempt was queued. */
  | { enqueued: false; reason: NextAttemptRefusal };

interface NextAttemptJob {
  orgId: string;
  listId: string;
  leadId: string;
  jobKey: string;
  /** The attempt that just ended; the next one is attemptNo + 1. */
  attemptNo: number;
}

const keyOf = (job: Pick<NextAttemptJob, 'jobKey' | 'attemptNo'>): string =>
  createHash('sha256').update(`${job.jobKey}|${job.attemptNo}`).digest('hex');

/**
 * The refusals that need no I/O. The call chain is measured from when the first member was rung, which was
 * itself within maxAgeMinutes of the submission, so a lead is never chased for much longer than that window.
 */
function staticRefusal(config: HotLeadCallConfig, record: HotLeadCallRecord, now: Date): NextAttemptRefusal | null {
  if (record.attemptNo >= config.maxAttemptsPerLead) return 'max_attempts';
  const startedAt = Date.parse(record.startedAt);
  if (!Number.isFinite(startedAt) || now.getTime() - startedAt > config.maxAgeMinutes * MINUTE_MS) return 'too_old';
  // Also empty outside the calling hours and when the whole team has been tried.
  if (selectHotLeadCallCandidates(config, now, record.triedMemberIds).length === 0) return 'no_candidates';
  return null;
}

/**
 * The checks both halves of the hand-over make: the request (right after an attempt ends) and the job (when it
 * runs): the org's live config, then the refusals that need no I/O, then the plan. The kill switch is the
 * caller's own first step. `expectedOrgId` is set by the job, whose org was fixed when it was queued.
 */
async function loadNextAttemptContext(
  listId: string, record: HotLeadCallRecord, expectedOrgId?: string,
): Promise<{ ctx: HotLeadCallContext; now: Date } | { refusal: NextAttemptRefusal }> {
  const ctx = await resolveHotLeadCallContext(listId);
  if (!ctx || (expectedOrgId && ctx.orgId !== expectedOrgId)) return { refusal: 'disabled' };
  const now = new Date();
  const refusal = staticRefusal(ctx.config, record, now);
  if (refusal) return { refusal };
  if (!await isHotLeadCallEntitled({ ownerUserId: ctx.orgOwnerUserId, orgId: ctx.orgId })) return { refusal: 'disabled' };
  return { ctx, now };
}

/**
 * Asks whether another team member should be called for this lead after the current member's attempt
 * ended without a bridge, and queues the next attempt if so. The voice webhooks call it after they have
 * metered the finished attempt and moved the record to `between_attempts`; when it answers
 * `enqueued: false` they finish the record. Webhooks never place calls themselves. Never throws.
 *
 * The queue key is the job key plus the finished attempt's number, so asking twice for the same attempt
 * (a replayed callback) queues one job.
 */
export async function requestNextHotLeadCallAttempt(args: {
  listId: string;
  leadId: string;
  record: HotLeadCallRecord;
}): Promise<NextAttemptDecision> {
  const { listId, leadId, record } = args;
  try {
    if (!await isHotLeadCallEnabled()) return { enqueued: false, reason: 'disabled' };
    const loaded = await loadNextAttemptContext(listId, record);
    if ('refusal' in loaded) return { enqueued: false, reason: loaded.refusal };

    const job: NextAttemptJob = { orgId: loaded.ctx.orgId, listId, leadId, jobKey: record.jobKey, attemptNo: record.attemptNo };
    // Not awaited to the end: the webhook answers Twilio at once.
    await runQueuedHotLeadJob({
      source: NEXT_ATTEMPT_SOURCE, key: keyOf(job), job, process: processHotLeadCallNextAttempt, label: 'Hot lead call next attempt', background: true, redriveFailed: true,
    });
    return { enqueued: true };
  } catch (err) {
    console.warn('[hotLeadCall] next attempt not queued', { listId, leadId, error: errorText(err) });
    return { enqueued: false, reason: 'no_candidates' };
  }
}

/**
 * Rings the next team member for a lead whose previous attempt ended. Re-runs the cheap safety checks (state
 * can change between the request and now), recomputes who is available at THIS moment, and places the call.
 * The conditional between_attempts -> dialing move is the per-attempt lock: a duplicate job, or one that
 * lost the race, stops there without dialing. Whenever it cannot ring anyone it closes the record, because the
 * webhooks leave a record in `between_attempts` for this job to resolve: that includes a job that fails, which
 * closes the record as failed (a record already past the lock, or one a call may be live on, is left alone:
 * the close only applies to `between_attempts`).
 */
export async function processHotLeadCallNextAttempt(job: NextAttemptJob): Promise<void> {
  if (!job || !isNonEmpty(job.orgId) || !isNonEmpty(job.listId) || !isNonEmpty(job.leadId) || !isNonEmpty(job.jobKey)
    || !Number.isInteger(job.attemptNo) || job.attemptNo < 1) throw new Error('Invalid hot lead call next attempt job');
  const progress = { endedAttempt: job.attemptNo };
  try {
    await placeNextAttempt(job, progress);
  } catch (err) {
    // The original error is the one to report; a close that fails as well leaves the record for a redelivery to heal.
    // The error may have come before the record was read, while it waits after a LATER attempt of this call (a re-run):
    // look once more so the close is guarded with the attempt the record is really waiting after.
    const store = getLeadCallStore();
    const attemptNo = await waitingAttemptOf(store, job) ?? progress.endedAttempt;
    await closeBetweenAttempts(store, { listId: job.listId, leadId: job.leadId, attemptNo, outcome: 'next_attempt_failed', closing: 'errored' })
      .catch((closeErr) => console.warn('[hotLeadCall] call record not closed', { listId: job.listId, leadId: job.leadId, error: errorText(closeErr) }));
    throw err;
  }
}

/** The attempt the lead's record is waiting after, when it is this call's and waiting; undefined when that cannot be read. */
async function waitingAttemptOf(store: LeadCallStore, job: NextAttemptJob): Promise<number | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const record = await store.get(job.listId, job.leadId);
      return record && record.jobKey === job.jobKey && record.state === 'between_attempts' ? record.attemptNo : undefined;
    } catch {
      // Tried once more; a record that cannot be read stays for the repair described in the runbook.
    }
  }
  return undefined;
}

/**
 * `progress.endedAttempt` is the attempt the record is waiting after: the job's own, or a later one when this job's
 * earlier run took the lock for the next attempt, had that call rejected, and died before it closed the record. Such
 * a record has no call sid, so no callback will ever come for it and only this job can carry it on.
 */
async function placeNextAttempt(job: NextAttemptJob, progress: { endedAttempt: number }): Promise<void> {
  const { listId, leadId } = job;
  const store = getLeadCallStore();
  if (!await isHotLeadCallEnabled()) {
    // No read and no call, but the record must not wait for a next attempt that will never come: one conditional
    // write closes it if (and only if) it is waiting between attempts.
    // Without a read there is no attempt number to guard with: any waiting record of the lead is closed.
    await closeBetweenAttempts(store, { listId, leadId, attemptNo: undefined, outcome: 'disabled', closing: 'completed' });
    return;
  }

  const record = await store.get(listId, leadId);
  // Another worker (or a replay) already moved this attempt on, or the record belongs to a different call. A record
  // waiting after a LATER attempt of the same call is this job's own earlier progress: carry on from there.
  if (!record || record.state !== 'between_attempts' || record.jobKey !== job.jobKey || record.attemptNo < job.attemptNo) return;
  const ended = record.attemptNo;
  progress.endedAttempt = ended;

  const loaded = await loadNextAttemptContext(listId, record, job.orgId);
  if ('refusal' in loaded) {
    await closeBetweenAttempts(store, {
      listId, leadId, attemptNo: ended, outcome: loaded.refusal === 'disabled' ? 'disabled' : 'no_member_available', closing: 'completed',
    });
    return;
  }
  const { ctx: { config }, now } = loaded;
  const callerNumber = config.twilioNumber;
  if (!callerNumber) {
    await closeBetweenAttempts(store, { listId, leadId, attemptNo: ended, outcome: 'no_member_available', closing: 'completed' });
    return;
  }

  await placeMemberCall({
    orgId: job.orgId, listId, leadId, jobKey: record.jobKey, config, callerNumber,
    candidates: selectHotLeadCallCandidates(config, now, record.triedMemberIds),
    attemptNo: ended + 1,
  });
}
