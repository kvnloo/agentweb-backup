import { createHash, randomUUID } from 'crypto';
import { isSmokeTestLead } from '../utils/smokeTestLead';
import { crmDb } from './db';
import { registerProcessor } from './asyncJobQueue';
import type { HotLeadCallConfig, HotLeadCallMember } from './hotLeadCallConfig';
import { callableLeadPhone, platformDailyMax } from './hotLeadCallConfig';
import type { LeadOrigin } from './leadNotificationConfig';
import { isInsideLeadCallWindow } from './voice/leadLocalHours';
import { getVoiceProvider } from './voice/voiceProvider';
import { isWebhookSafeId } from './voice/voiceUrls';
import { isHotLeadCallEnabled } from './voice/hotLeadCallMode';
import { hasCallConsent } from './voice/callConsent';
import { isLeadDoNotCall } from './voice/hotLeadCallDnc';
import { isHotLeadCallEntitled } from './voice/hotLeadCallEntitlement';
import { resolveHotLeadCallContext, type HotLeadCallContext } from './voice/hotLeadCallContext';
import { getLeadCallStore } from './voice/leadCallStore';
import type { HotLeadCallRecord } from './voice/leadCallStore.types';
import { leadPhoneMacOf } from './voice/leadPhoneMac';
import { notifyPlatformCap } from './voice/hotLeadCallPlatformAlert';
import { isWithinCallWindow, reserveCallSlot, type Reservation } from './voice/hotLeadCallLimits';
import { notifyMonthlyCap } from './voice/hotLeadCallCapNotices';
import { selectHotLeadCallCandidates } from './hotLeadCallRoster';
import { NEXT_ATTEMPT_SOURCE, processHotLeadCallNextAttempt } from './hotLeadCallAttempts';
import { holdsClaim, placeMemberCall, type PlacementResult } from './hotLeadCallPlacement';
import { runQueuedHotLeadJob } from './hotLeadCallQueue';
import { nextAttemptOrFinish } from './voice/callFinalisation';
import { errorText, isNonEmpty, MINUTE_MS } from './hotLeadCallText';
import { openAtOrAfter, RETRY_EXPIRES_AFTER_MS, RETRY_REQUEUE_MS, retryDueAt } from './voice/hotLeadCallRetry';
// This file must not import orgLeadNotificationService: that module calls dispatchHotLeadCall.

interface HotLeadCallJob {
  orgId: string;
  listId: string;
  leadId: string;
  origin: LeadOrigin;
  submissionId?: string;
  submittedAt?: string;
  /**
   * Set only for the lead's one retry (press 2, ENG-2783), which runs the same gates and placement on the lead's finished
   * record: it ignores the "lead already has a call record" short-circuit and the age gate (age is counted from the
   * deferral) and may use the phone marker its own first call took. `token` is the claim the due-retries cron won and
   * `fromJobKey` the first call's job key, which the restart of the finished record is conditional on.
   */
  retry?: { token: string; fromJobKey: string };
}
type JobInput = Omit<HotLeadCallJob, 'orgId'>;
type Submission = { submissionId: string; submittedAt: string };

const SOURCE = 'hot_lead_call';
// Anyone can submit a landing-page form, and again, so refusals must not grow the lead row without bound:
// one `call.skipped` event per distinct reason, and five in all.
const MAX_SKIP_EVENTS_PER_LEAD = 5;
const keyOf = (job: HotLeadCallJob): string =>
  createHash('sha256').update(JSON.stringify([job.orgId, job.listId, job.leadId, ...(job.submissionId ? [job.submissionId] : []), ...(job.retry ? ['retry', job.retry.token] : [])])).digest('hex');

type LeadRow = NonNullable<Awaited<ReturnType<typeof crmDb.getLeadById>>>;
interface GateInput { config: HotLeadCallConfig; lead: LeadRow; job: HotLeadCallJob }

// Gates that record `call.skipped` when they refuse, cheapest first. Each returns a skip reason or null.
// Order: ids, phone, call consent, org calling hours, lead-local hours, team availability, age. The async gates (do_not_call, plan) follow in review().
const SKIP_GATES: Array<(g: GateInput) => string | null> = [
  // The webhooks reject ids outside their strict shape; Twilio would ring the member and every callback would fail.
  ({ job }) => (isWebhookSafeId(job.listId) && isWebhookSafeId(job.leadId) ? null : 'unsafe_id'),
  ({ lead, config }) => {
    const callable = callableLeadPhone(lead.phone, config);
    return 'reason' in callable ? callable.reason : null;
  },
  // ENG-2783: an automated call to a mobile needs the person's recorded prior express consent. A lead without
  // `system.callConsent` (a form with no call-consent notice, or an old lead) is never dialed. Stateless and one field
  // read, so it runs in every pass including the retry; PERMANENT_REFUSALS spends the retry for it.
  ({ lead }) => (hasCallConsent(lead) ? null : 'no_call_consent'),
  // Stateless, so it runs in every pass; the limits that count calls run once, just before create. A skip leaves
  // the lead's call slot unused, and the Slack alert goes out regardless.
  ({ config }) => (isWithinCallWindow(config.callingHours, new Date()) ? null : 'outside_calling_hours'),
  // The lead's own local time (leadLocalHours.ts, conservative across US zones); stateless like the org window.
  ({ lead, config }) => {
    const callable = callableLeadPhone(lead.phone, config);
    return 'phone' in callable && !isInsideLeadCallWindow(callable.phone, new Date()) ? 'outside_lead_hours' : null;
  },
  // Inside the calling hours but nobody on the team has a window open (or none is verified).
  ({ config }) => (selectHotLeadCallCandidates(config, new Date()).length > 0 ? null : 'no_one_available'),
  // Protects against queue-reclaim delays: a lead that waited too long is no longer "hot". A missing or
  // unparseable timestamp fails closed.
  ({ lead, job, config }) => {
    if (job.retry) return null; // a retry's age is measured from the deferral, and the cron expires it after six hours
    const at = Date.parse(job.submittedAt ?? String(lead.createdAt ?? ''));
    return Number.isFinite(at) && Date.now() - at <= config.maxAgeMinutes * MINUTE_MS ? null : 'too_old';
  },
];

/** Records `call.skipped` unless this lead's timeline already has that reason or the per-lead cap. Never throws. */
async function recordSkip(lead: LeadRow, reason: string): Promise<void> {
  const skipped: Array<{ eventData?: { reason?: unknown } }> = (Array.isArray(lead.engagements) ? lead.engagements : []).filter(
    (e: { eventType?: unknown }) => e?.eventType === 'call.skipped',
  );
  if (skipped.length >= MAX_SKIP_EVENTS_PER_LEAD || skipped.some((e) => e.eventData?.reason === reason)) return;
  await getLeadCallStore().addEvent(lead.listId, lead.leadId, 'call.skipped', { reason });
}

/** Why a review or preflight stopped (the same reason that was recorded as `call.skipped`, or a short silent one). */
interface Refusal { refused: string }
type ReviewedLead = { job: HotLeadCallJob; ctx: HotLeadCallContext; phone: string; callerNumber: string; lead: LeadRow };
type Reviewed = ReviewedLead;
type Ready = Reviewed & { candidates: HotLeadCallMember[] };
const refusal = (refused: string): Refusal => ({ refused });

/**
 * Everything that decides whether this lead should ring a team member, cheapest check first, saying WHY when it does not (the
 * press-2 retry needs the reason: some refusals are final, some pass with time). Runs at dispatch and again in the job (state
 * can change in between). Refusals worth showing on the timeline also record `call.skipped`; the silent ones have a reason too.
 */
async function reviewWhy(input: JobInput, expectedOrgId?: string): Promise<ReviewedLead | Refusal> {
  const { listId, leadId, origin } = input;
  if (origin !== 'form_fill') return refusal('not_form_fill');
  const ctx = await resolveHotLeadCallContext(listId);
  if (!ctx || (expectedOrgId && ctx.orgId !== expectedOrgId)) return refusal('ctx_missing');
  if (!ctx.config.leadTypes.includes(origin)) return refusal('lead_type_off');

  const lead = await crmDb.getLeadById(listId, leadId, { consistentRead: true });
  if (!lead || lead.listId !== listId || lead.leadId !== leadId) return refusal('lead_missing');
  // A lead gets one call record ever, so a repeat submission (fresh submissionId, same lead) has nothing to
  // start: stop before it costs a job row, reservations or timeline reads. The lead row is already loaded.
  if (lead.system?.hot_lead_call && !input.retry) return refusal('has_record');
  // Silent on purpose: synthetic smoke-test leads (smoke-test+N@agentweb.pro, or the reserved fictional
  // 415-555-01xx phones) must never ring anyone, and a timeline event would just be noise.
  if (isSmokeTestLead(lead)) return refusal('smoke_test');
  // Progressive email capture is a draft; the lead only counts once the form advances.
  if (lead.customFields?.stage === 'email') return refusal('draft_lead');
  if (!isNonEmpty(lead.phone)) return refusal('invalid_phone');

  // Enabled configs are validated to have one, but the call must never reach create without it: a skip
  // keeps the lead's single call slot unused.
  const callerNumber = ctx.config.twilioNumber;
  if (!callerNumber) {
    await recordSkip(lead, 'no_caller_number');
    return refusal('no_caller_number');
  }

  const job: HotLeadCallJob = { ...input, orgId: ctx.orgId };
  for (const gate of SKIP_GATES) {
    const reason = gate({ config: ctx.config, lead, job });
    if (reason) {
      await recordSkip(lead, reason);
      return refusal(reason);
    }
  }
  // After the stateless gates: it reads the org owner's plan. An org that lost its plan stops dialing here.
  if (!await isHotLeadCallEntitled({ ownerUserId: ctx.orgOwnerUserId, orgId: ctx.orgId })) {
    await recordSkip(lead, 'not_entitled');
    return refusal('not_entitled');
  }
  const callable = callableLeadPhone(lead.phone, ctx.config);
  if (!('phone' in callable)) return refusal('invalid_phone'); // always set: the phone gate refused otherwise
  // Reads the org's do-not-call marker for this number (a lead who pressed 3 once) and the lead's own contact status.
  // The marker sits in the limit store: when that fails nothing is dialed, and the lead shows the same limits_unavailable as a failed reservation.
  let blocked: boolean;
  try {
    blocked = await isLeadDoNotCall({ orgId: ctx.orgId, lead, phoneE164: callable.phone });
  } catch (err) {
    console.warn('[hotLeadCall] do-not-call check unavailable', { listId, leadId, error: errorText(err) });
    await recordSkip(lead, 'limits_unavailable').catch(() => undefined);
    throw err;
  }
  if (blocked) {
    await recordSkip(lead, 'do_not_call');
    return refusal('do_not_call');
  }
  return { job, ctx, phone: callable.phone, callerNumber, lead };
}

/** `reviewWhy` for the dispatch path: null for "do nothing". */
async function review(input: JobInput, expectedOrgId?: string): Promise<ReviewedLead | null> {
  const result = await reviewWhy(input, expectedOrgId);
  return 'refused' in result ? null : result;
}

/**
 * Everything that must hold before a slot is reserved: the kill switch, the gates, somebody on the team available
 * right now (time moves on between the gates and the reservation), and Twilio credentials. Says why it stopped when it does;
 * refusals worth showing on the timeline have been recorded.
 */
async function preflightWhy(job: HotLeadCallJob): Promise<Ready | Refusal> {
  if (!await isHotLeadCallEnabled()) return refusal('disabled');
  const reviewed = await reviewWhy(job, job.orgId);
  if ('refused' in reviewed) return reviewed;

  const candidates = selectHotLeadCallCandidates(reviewed.ctx.config, new Date());
  if (candidates.length === 0) {
    await recordSkip(reviewed.lead, 'no_one_available');
    return refusal('no_one_available');
  }

  // Before any slot or record: with no usable Twilio credentials nothing can be dialed, and the lead's single
  // call slot (and the org's caps) must stay unused so a later submission can try again.
  try {
    await getVoiceProvider().ensureCredentials();
  } catch (err) {
    console.warn('[hotLeadCall] voice credentials unavailable', { listId: job.listId, leadId: job.leadId, error: errorText(err) });
    await recordSkip(reviewed.lead, 'credentials_unavailable');
    return refusal('credentials_unavailable');
  }
  return { ...reviewed, candidates };
}

/** `preflightWhy` for the dispatch path: null when the job should stop. */
async function preflight(job: HotLeadCallJob): Promise<Ready | null> {
  const result = await preflightWhy(job);
  return 'refused' in result ? null : result;
}

/**
 * Reserves the lead's slots, then rings the first available member. The slots are taken BEFORE the record is
 * created and given back if it is not: a lead that never dials costs no slot, and a lead refused by a limit
 * leaves no record, so its single call slot stays unused (a repeat submission can retry).
 */
async function reserveAndPlace(job: HotLeadCallJob, reviewed: Ready): Promise<string | null> {
  const { retry } = job;
  const { config } = reviewed.ctx;
  const { listId, leadId } = job;
  let slot: Reservation;
  try {
    slot = await reserveCallSlot({ orgId: job.orgId, listId, leadId, phoneE164: reviewed.phone, config, retry: !!job.retry });
  } catch (err) {
    // Fail closed (nothing dialed, no record) but leave a trace on the lead: a missing table or secret is an ops problem.
    console.warn('[hotLeadCall] call limits unavailable', { listId, leadId, error: errorText(err) });
    // The timeline write is best-effort: it must never mask the original failure.
    await recordSkip(reviewed.lead, 'limits_unavailable').catch(() => undefined);
    throw err;
  }
  if (!slot.ok) {
    // The same lead is being dialed by a racing dispatch (it holds the phone marker): nothing to add to the timeline.
    // A different lead on the same number, or a cap, is worth showing.
    if (slot.reason !== 'in_progress') await recordSkip(reviewed.lead, slot.reason);
    // Fire-and-forget (never awaited, never throws): the owner's one-per-month "paused until the 1st" email.
    if (slot.reason === 'org_monthly_cap') void notifyMonthlyCap({ orgId: job.orgId, ownerUserId: reviewed.ctx.orgOwnerUserId, config, event: { kind: 'refused' } });
    // Fire-and-forget: the operator alarm (error log + optional email) for the platform-wide daily ceiling.
    if (slot.reason === 'platform_daily_cap') void notifyPlatformCap({ cap: platformDailyMax(), now: slot.at, event: { kind: 'refused' } });
    return slot.reason;
  }
  void notifyPlatformCap({ cap: slot.platformCap, now: slot.at, event: { kind: 'counted', used: slot.platformUsed } });
  void notifyMonthlyCap({ orgId: job.orgId, ownerUserId: reviewed.ctx.orgOwnerUserId, config, event: { kind: 'counted', used: slot.monthlyUsed } });

  const store = getLeadCallStore();
  const jobKey = keyOf(job);
  let created = false;
  let result: PlacementResult;
  try {
    result = await placeMemberCall({
      orgId: job.orgId, listId, leadId, jobKey, config, callerNumber: reviewed.callerNumber, candidates: reviewed.candidates, attemptNo: 1,
      createRecord: async (member, claimToken) => {
        const startedAt = new Date().toISOString();
        let failure: unknown;
        const leadPhoneMac = leadPhoneMacOf(job.orgId, reviewed.phone);
        try {
          created = retry
            ? await store.restartForRetry(listId, leadId, { jobKey: retry.fromJobKey, token: retry.token }, { jobKey, startedAt, memberId: member.id, claimToken, leadPhoneMac })
            : await store.create(listId, leadId, {
              state: 'dialing', jobKey, startedAt, updatedAt: startedAt, attemptNo: 1, memberId: member.id, triedMemberIds: [member.id], leadPhoneMac, claimToken,
            });
        } catch (err) {
          failure = err;
        }
        // A create that committed and then reported an error, or reported that the record already exists because the
        // SDK retried it after losing the response, still made the record ours; without it the lead's single call slot
        // would be burned with no call. `false` for a record that really belongs to another dispatch carries another
        // token. Otherwise nothing was created.
        if (!created && await holdsClaim(store, listId, leadId, claimToken).catch(() => false)) created = true;
        if (!created && failure) throw failure;
        return created;
      },
    });
  } finally {
    // No record means no call: give the lead's slots back (a lost create, every member in cooldown, or an error).
    if (!created) await slot.release();
  }
  if (result === 'none') await recordSkip(reviewed.lead, 'member_cooldown');
  // Why nothing was dialed, for the retry's drop log; null when a call was placed or another worker owns the record.
  return result === 'none' ? 'member_cooldown' : null;
}

/**
 * A queue poller re-runs a job whose process died. When this job's own record is waiting between attempts (its first
 * member was rejected and the pass did not get further) nothing else will ever move it: no call is in flight, so no
 * callback will come. It is handed to the next-attempt path, which queues the next member or finishes the record.
 */
async function resumedWaitingRecord(job: HotLeadCallJob): Promise<boolean> {
  const record = await getLeadCallStore().get(job.listId, job.leadId);
  if (!record || record.jobKey !== keyOf(job) || record.state !== 'between_attempts') return false;
  await nextAttemptOrFinish({ listId: job.listId, leadId: job.leadId, jobKey: record.jobKey, leg: 'member' }, record.outcome ?? 'place_rejected');
  return true;
}

/**
 * Re-runs the gates, then rings the first available member, at most once per lead. The call record is the
 * at-most-once control: store.create is create-if-absent, so a lost create means a record already exists for
 * this lead and we never dial, and a throw means nothing was dialed and the job fails (the queue row dedupes
 * the same job key). A lead gets one call record ever; its later attempts (other members) are driven from that
 * record by the next-attempt job, and a lead whose first call was rejected is not retried by a new submission.
 */
export async function processHotLeadCallJob(job: HotLeadCallJob): Promise<void> {
  if (!job || !isNonEmpty(job.orgId) || !isNonEmpty(job.listId) || !isNonEmpty(job.leadId)) throw new Error('Invalid hot lead call job');
  if (await resumedWaitingRecord(job)) return;
  const ready = await preflight(job);
  if (ready) await reserveAndPlace(job, ready);
}

type RetryOutcome =
  /** Nothing to do for this record (no pending deferral, a claimed one, or the hot-lead call is off). */
  | 'not_pending'
  | 'not_due'
  /** Put back for later, unclaimed: a window was closed at run time, or a transient refusal gave the claim back. */
  | 'rescheduled'
  /** Another run or instance holds the claim. */
  | 'lost'
  | 'expired'
  /** A permanent refusal spent the retry; `call.skipped` carries the reason (the lead was not called). */
  | 'refused'
  /** The retry started: the record was restarted and the first member is being rung (or the placement ran into a rejection after that). */
  | 'attempted';

/**
 * Refusals that spend the retry for good: the lead cannot or must not be called, however long we wait. Everything else
 * (no one on duty, member cooldown, the hourly/daily/monthly caps and the platform daily ceiling, a closed window, an unreachable limit store or Twilio, any thrown
 * error, any reason not listed here) passes with time, so the claim is given back and the retry tried again later.
 */
const PERMANENT_REFUSALS = new Set([
  'lead_missing', 'ctx_missing', 'lead_phone_changed', 'do_not_call', 'not_entitled', 'duplicate_phone',
  'smoke_test', 'draft_lead', 'invalid_phone', 'no_call_consent', 'country_not_allowed', 'unsafe_id', 'not_form_fill', 'has_record', 'retry_expired',
]);

const retryLog = (what: 'dropped' | 'rescheduled', reason: string, orgId: string): void =>
  console.warn(`[hotLeadCall] retry ${what} after claim ${reason} ${orgId}`);

/** The expiry note, written as its own event: the per-lead skip cap and the one-per-reason dedupe must never swallow it. */
async function recordRetryExpired(lead: LeadRow): Promise<void> {
  await getLeadCallStore().addEvent(lead.listId, lead.leadId, 'call.skipped', { reason: 'retry_expired' });
}

/**
 * The lead's one retry (press 2, ENG-2783), run by the due-retries cron for a lead whose record is finished with outcome
 * `lead_deferred`. In order: the kill switch; the record is a pending deferral; more than six hours past its FIRST due time
 * (whatever its current dueAt says, a future one included) is claimed and given up as `retry_expired`; not yet due is left alone;
 * a lead or org window that is closed AT THIS MOMENT moves the deferral to the next open minute counted from now, inside those six
 * hours, without claiming it (a late cron tick must not spend the retry); the CLAIM (the conditional write that makes the retry happen at
 * most once, whoever else is running); every gate of a new lead except the age and the existing-record checks; the lead's
 * phone still being the one approved; a fresh slot against the hourly, daily and monthly caps; a fresh pass over the team.
 *
 * After the claim only a PERMANENT refusal spends the retry (`PERMANENT_REFUSALS`, logged `retry dropped after claim`); a
 * transient one, or a thrown error, gives the claim back with `releaseRetryClaim` (token-guarded) and a new due time 15 minutes
 * on or the next minute both windows are open (logged `retry rescheduled after claim`), until `deferral.firstDueAt` + 6 hours,
 * when it is spent as `retry_expired`. Once the record is restarted a real call began and the retry is spent.
 */
export async function processHotLeadCallRetry(listId: string, leadId: string, now: Date = new Date()): Promise<RetryOutcome> {
  if (!await isHotLeadCallEnabled()) return 'not_pending';
  const store = getLeadCallStore();
  const record = await store.get(listId, leadId);
  const dueAt = Date.parse(record?.deferral?.dueAt ?? '');
  if (!record || record.state !== 'finished' || record.outcome !== 'lead_deferred' || record.retryClaimToken !== undefined || !Number.isFinite(dueAt)) return 'not_pending';
  // Contract: the retry is placed within six hours of its FIRST due time or it is given up, never moved to another day. Records written
  // before `firstDueAt` existed fall back to their current dueAt. The give-up comes before "not due yet": a deferral whose dueAt lies in
  // the future but whose firstDueAt is older than the limit (an operator-written or older-shape record) must be given up, not left waiting.
  // An unparseable firstDueAt would make the limit NaN and silently disable the expiry: it falls back to dueAt too, and one value is used everywhere.
  const parsedFirst = Date.parse(record.deferral?.firstDueAt ?? '');
  const firstMs = Number.isFinite(parsedFirst) ? parsedFirst : dueAt;
  const firstDueAt = new Date(firstMs).toISOString();
  const giveUpAt = firstMs + RETRY_EXPIRES_AFTER_MS;
  const token = randomUUID();
  const claim = (): Promise<boolean> => store.claimRetry(listId, leadId, record.jobKey, token);
  const giveUp = async (known?: LeadRow | null): Promise<RetryOutcome> => {
    if (!await claim()) return 'lost';
    const lead = known === undefined ? await crmDb.getLeadById(listId, leadId, { consistentRead: true }) : known;
    if (lead) await recordRetryExpired(lead);
    return 'expired';
  };
  if (now.getTime() > giveUpAt) return giveUp();
  if (now.getTime() < dueAt) return 'not_due';

  const ctx = await resolveHotLeadCallContext(listId);
  const lead = await crmDb.getLeadById(listId, leadId, { consistentRead: true });
  const orgId = ctx?.orgId ?? 'unknown_org';
  const callable = ctx && lead ? callableLeadPhone(lead.phone, ctx.config) : null;
  if (ctx && callable && 'phone' in callable && !(isInsideLeadCallWindow(callable.phone, now) && isWithinCallWindow(ctx.config.callingHours, now))) {
    // A due retry whose window is closed: the next open minute counted from NOW (the 60 minute delay belongs to the press, not here).
    const next = retryDueAt(callable.phone, ctx.config, now, 0);
    if (!next || next.getTime() > giveUpAt) return giveUp(lead);
    const moved = await store.rescheduleRetry(listId, leadId, record.jobKey, { dueAt: next.toISOString(), firstDueAt });
    return moved ? 'rescheduled' : 'lost';
  }

  if (!await claim()) return 'lost';

  /** After the claim: the permanent reasons spend it, every other reason gives it back until firstDueAt + 6 hours. */
  const settle = async (reason: string): Promise<RetryOutcome> => {
    if (PERMANENT_REFUSALS.has(reason)) {
      retryLog('dropped', reason, orgId);
      return 'refused';
    }
    const phone = callable && 'phone' in callable ? callable.phone : null;
    // A refusal is not a window problem, so the +15 minute floor stays (hammering a full cap or a busy team every cron tick helps no one);
    // the window search only pushes it later when 15 minutes on is closed.
    const earliest = now.getTime() + RETRY_REQUEUE_MS;
    const next = phone && ctx ? openAtOrAfter(phone, ctx.config, earliest) : new Date(earliest);
    if (!next || next.getTime() > giveUpAt) {
      if (lead) await recordRetryExpired(lead);
      retryLog('dropped', 'retry_expired', orgId);
      return 'expired';
    }
    if (!await store.releaseRetryClaim(listId, leadId, token, { dueAt: next.toISOString(), firstDueAt })) return 'lost';
    retryLog('rescheduled', reason, orgId);
    return 'rescheduled';
  };

  let reason: string | null;
  try {
    reason = await tryRetry({ ctx, lead, record, token, orgId });
  } catch (err) {
    // A thrown error is transient; the claim is given back first so the retry survives, then the error goes on.
    await settle('error').catch((releaseErr) => console.warn('[hotLeadCall] retry claim not released', { listId, leadId, error: errorText(releaseErr) }));
    throw err;
  }
  return reason === null ? 'attempted' : settle(reason);
}

/** The claimed retry's gates, phone check, slot and placement. The refusal reason, or null once the retry has started. */
async function tryRetry(c: { ctx: HotLeadCallContext | null; lead: LeadRow | null; record: HotLeadCallRecord; token: string; orgId: string }): Promise<string | null> {
  const { ctx, lead, record, token } = c;
  if (!ctx) return 'ctx_missing';
  if (!lead) return 'lead_missing';
  const job: HotLeadCallJob = { orgId: ctx.orgId, listId: lead.listId, leadId: lead.leadId, origin: 'form_fill', retry: { token, fromJobKey: record.jobKey } };
  const ready = await preflightWhy(job);
  if ('refused' in ready) return ready.refused;
  // The person pressed 2 on the number that was approved for the first call; a later submission may have replaced it.
  if (record.leadPhoneMac !== leadPhoneMacOf(ctx.orgId, ready.phone)) {
    await recordSkip(ready.lead, 'lead_phone_changed');
    return 'lead_phone_changed';
  }
  return reserveAndPlace(job, ready);
}

/** Never rejects to a lead saver. Fire-and-forget right after a successful lead write. */
export async function dispatchHotLeadCall(listId: string, leadId: string, origin?: LeadOrigin, submission?: Submission): Promise<void> {
  try {
    if (!await isHotLeadCallEnabled()) return;
    if (!origin) return;
    const reviewed = await review({ listId, leadId, origin, ...submission });
    if (!reviewed) return;
    const { job } = reviewed;
    await runQueuedHotLeadJob({ source: SOURCE, key: keyOf(job), job, process: processHotLeadCallJob, label: 'Hot lead call' });
  } catch (err) {
    console.warn('[hotLeadCall] dispatch failed', { listId, leadId, error: errorText(err) });
  }
}

export function registerHotLeadCallProcessor(): void {
  registerProcessor(SOURCE, processHotLeadCallJob, { maxAttempts: 1 });
  registerProcessor(NEXT_ATTEMPT_SOURCE, processHotLeadCallNextAttempt, { maxAttempts: 1 });
}
