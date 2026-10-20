import { createHash } from 'crypto';
import { enqueueJob, markJobComplete, markJobFailed, startHeartbeat } from './asyncJobQueue';
import type { HotLeadCallConfig } from './hotLeadCallConfig';
import { selectHotLeadCallCandidates } from './hotLeadCallRoster';
import { closeBetweenAttempts, errorText, placeMemberCall } from './hotLeadCallPlacement';
import { resolveHotLeadCallContext } from './voice/hotLeadCallContext';
import { isHotLeadCallEntitled } from './voice/hotLeadCallEntitlement';
import { isHotLeadCallEnabled } from './voice/hotLeadCallMode';
import { getLeadCallStore } from './voice/leadCallStore';
import type { HotLeadCallRecord } from './voice/leadCallStore.types';

export const NEXT_ATTEMPT_SOURCE = 'hot_lead_call_next';
const MINUTE_MS = 60_000;

export type NextAttemptRefusal = 'max_attempts' | 'too_old' | 'no_candidates' | 'disabled';

export interface NextAttemptDecision {
  enqueued: boolean;
  /** Why no further attempt was queued; absent when enqueued. */
  reason?: NextAttemptRefusal;
}

interface NextAttemptJob {
  orgId: string;
  listId: string;
  leadId: string;
  jobKey: string;
  /** The attempt that just ended; the next one is attemptNo + 1. */
  attemptNo: number;
}

const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
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
    const ctx = await resolveHotLeadCallContext(listId);
    if (!ctx) return { enqueued: false, reason: 'disabled' };
    const refusal = staticRefusal(ctx.config, record, new Date());
    if (refusal) return { enqueued: false, reason: refusal };
    if (!await isHotLeadCallEntitled({ ownerUserId: ctx.orgOwnerUserId })) return { enqueued: false, reason: 'disabled' };

    const job: NextAttemptJob = { orgId: ctx.orgId, listId, leadId, jobKey: record.jobKey, attemptNo: record.attemptNo };
    const key = keyOf(job);
    const queued = await enqueueJob(NEXT_ATTEMPT_SOURCE, key, job, { claimImmediately: true });
    if (queued === 'duplicate') return { enqueued: true };
    if (queued !== 'enqueued') throw new Error('Hot lead call queue unavailable');
    // Not awaited: the webhook answers Twilio at once. A crash here is covered by the queue reclaiming the job.
    void runNextAttempt(job, key);
    return { enqueued: true };
  } catch (err) {
    console.warn('[hotLeadCall] next attempt not queued', { listId, leadId, error: errorText(err) });
    return { enqueued: false, reason: 'no_candidates' };
  }
}

async function runNextAttempt(job: NextAttemptJob, key: string): Promise<void> {
  const stop = startHeartbeat(NEXT_ATTEMPT_SOURCE, key);
  try {
    await processHotLeadCallNextAttempt(job);
    await markJobComplete(NEXT_ATTEMPT_SOURCE, key);
  } catch (err) {
    await markJobFailed(NEXT_ATTEMPT_SOURCE, key, new Error(`Hot lead call next attempt failed: ${errorText(err)}`)).catch(() => undefined);
  } finally { stop(); }
}

/**
 * Rings the next team member for a lead whose previous attempt ended. Re-runs the cheap safety checks (state
 * can change between the request and now), recomputes who is available at THIS moment, and places the call.
 * The conditional between_attempts -> dialing move is the per-attempt lock: a duplicate job, or one that
 * lost the race, stops there without dialing. Whenever it cannot ring anyone it closes the record, because the
 * webhooks leave a record in `between_attempts` for this job to resolve.
 */
export async function processHotLeadCallNextAttempt(job: NextAttemptJob): Promise<void> {
  if (!job || !isNonEmpty(job.orgId) || !isNonEmpty(job.listId) || !isNonEmpty(job.leadId) || !isNonEmpty(job.jobKey)
    || !Number.isInteger(job.attemptNo) || job.attemptNo < 1) throw new Error('Invalid hot lead call next attempt job');
  const { listId, leadId } = job;
  const store = getLeadCallStore();
  if (!await isHotLeadCallEnabled()) {
    // No read and no call, but the record must not wait for a next attempt that will never come: one conditional
    // write closes it if (and only if) it is waiting between attempts.
    await closeBetweenAttempts(store, listId, leadId, 'disabled', false);
    return;
  }

  const record = await store.get(listId, leadId);
  // Another worker (or a replay) already moved this attempt on, or the record belongs to a different call.
  if (!record || record.state !== 'between_attempts' || record.jobKey !== job.jobKey || record.attemptNo !== job.attemptNo) return;

  const ctx = await resolveHotLeadCallContext(listId);
  if (!ctx || ctx.orgId !== job.orgId || !await isHotLeadCallEntitled({ ownerUserId: ctx.orgOwnerUserId })) {
    await closeBetweenAttempts(store, listId, leadId, 'disabled', false);
    return;
  }
  const { config } = ctx;
  const now = new Date();
  if (staticRefusal(config, record, now)) {
    await closeBetweenAttempts(store, listId, leadId, 'no_member_available', false);
    return;
  }
  const callerNumber = config.twilioNumber;
  if (!callerNumber) {
    await closeBetweenAttempts(store, listId, leadId, 'no_member_available', false);
    return;
  }

  await placeMemberCall({
    orgId: job.orgId, listId, leadId, jobKey: record.jobKey, config, callerNumber,
    candidates: selectHotLeadCallCandidates(config, now, record.triedMemberIds),
    attemptNo: job.attemptNo + 1,
  });
}
