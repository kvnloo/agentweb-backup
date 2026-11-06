import { createHash } from 'crypto';
import { isSmokeTestLead } from '../utils/smokeTestLead';
import { crmDb } from './db';
import { registerProcessor } from './asyncJobQueue';
import type { HotLeadCallConfig, HotLeadCallMember } from './hotLeadCallConfig';
import { callableLeadPhone } from './hotLeadCallConfig';
import type { LeadOrigin } from './leadNotificationConfig';
import { isInsideLeadCallWindow } from './voice/leadLocalHours';
import { getVoiceProvider } from './voice/voiceProvider';
import { isWebhookSafeId } from './voice/voiceUrls';
import { isHotLeadCallEnabled } from './voice/hotLeadCallMode';
import { isLeadDoNotCall } from './voice/hotLeadCallDnc';
import { isHotLeadCallEntitled } from './voice/hotLeadCallEntitlement';
import { resolveHotLeadCallContext, type HotLeadCallContext } from './voice/hotLeadCallContext';
import { getLeadCallStore } from './voice/leadCallStore';
import { leadPhoneMacOf } from './voice/leadPhoneMac';
import { isWithinCallWindow, reserveCallSlot, type Reservation } from './voice/hotLeadCallLimits';
import { notifyMonthlyCap } from './voice/hotLeadCallCapNotices';
import { selectHotLeadCallCandidates } from './hotLeadCallRoster';
import { NEXT_ATTEMPT_SOURCE, processHotLeadCallNextAttempt } from './hotLeadCallAttempts';
import { holdsClaim, placeMemberCall, type PlacementResult } from './hotLeadCallPlacement';
import { runQueuedHotLeadJob } from './hotLeadCallQueue';
import { nextAttemptOrFinish } from './voice/callFinalisation';
import { errorText, isNonEmpty, MINUTE_MS } from './hotLeadCallText';
// This file must not import orgLeadNotificationService: that module calls dispatchHotLeadCall.

interface HotLeadCallJob {
  orgId: string;
  listId: string;
  leadId: string;
  origin: LeadOrigin;
  submissionId?: string;
  submittedAt?: string;
}
type JobInput = Omit<HotLeadCallJob, 'orgId'>;
type Submission = { submissionId: string; submittedAt: string };

const SOURCE = 'hot_lead_call';
// Anyone can submit a landing-page form, and again, so refusals must not grow the lead row without bound:
// one `call.skipped` event per distinct reason, and five in all.
const MAX_SKIP_EVENTS_PER_LEAD = 5;
const keyOf = (job: HotLeadCallJob): string =>
  createHash('sha256').update(JSON.stringify([job.orgId, job.listId, job.leadId, ...(job.submissionId ? [job.submissionId] : [])])).digest('hex');

type LeadRow = NonNullable<Awaited<ReturnType<typeof crmDb.getLeadById>>>;
interface GateInput { config: HotLeadCallConfig; lead: LeadRow; job: HotLeadCallJob }

// Gates that record `call.skipped` when they refuse, cheapest first. Each returns a skip reason or null.
// Order: ids, phone, org calling hours, lead-local hours, team availability, age. The async gates (do_not_call, plan) follow in review().
const SKIP_GATES: Array<(g: GateInput) => string | null> = [
  // The webhooks reject ids outside their strict shape; Twilio would ring the member and every callback would fail.
  ({ job }) => (isWebhookSafeId(job.listId) && isWebhookSafeId(job.leadId) ? null : 'unsafe_id'),
  ({ lead, config }) => {
    const callable = callableLeadPhone(lead.phone, config);
    return 'reason' in callable ? callable.reason : null;
  },
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

/**
 * Everything that decides whether this lead should ring a team member, cheapest check first. Runs at
 * dispatch and again in the job (state can change in between). Returns null for "do nothing";
 * refusals worth showing on the timeline also record `call.skipped`.
 */
async function review(input: JobInput, expectedOrgId?: string): Promise<{ job: HotLeadCallJob; ctx: HotLeadCallContext; phone: string; callerNumber: string; lead: LeadRow } | null> {
  const { listId, leadId, origin } = input;
  if (origin !== 'form_fill') return null;
  const ctx = await resolveHotLeadCallContext(listId);
  if (!ctx || (expectedOrgId && ctx.orgId !== expectedOrgId)) return null;
  if (!ctx.config.leadTypes.includes(origin)) return null;

  const lead = await crmDb.getLeadById(listId, leadId, { consistentRead: true });
  if (!lead || lead.listId !== listId || lead.leadId !== leadId) return null;
  // A lead gets one call record ever, so a repeat submission (fresh submissionId, same lead) has nothing to
  // start: stop before it costs a job row, reservations or timeline reads. The lead row is already loaded.
  if (lead.system?.hot_lead_call) return null;
  // Silent on purpose: synthetic smoke-test leads (smoke-test+N@agentweb.pro, or the reserved fictional
  // 415-555-01xx phones) must never ring anyone, and a timeline event would just be noise.
  if (isSmokeTestLead(lead)) return null;
  // Progressive email capture is a draft; the lead only counts once the form advances.
  if (lead.customFields?.stage === 'email') return null;
  if (!isNonEmpty(lead.phone)) return null;

  // Enabled configs are validated to have one, but the call must never reach create without it: a skip
  // keeps the lead's single call slot unused.
  const callerNumber = ctx.config.twilioNumber;
  if (!callerNumber) {
    await recordSkip(lead, 'no_caller_number');
    return null;
  }

  const job: HotLeadCallJob = { ...input, orgId: ctx.orgId };
  for (const gate of SKIP_GATES) {
    const reason = gate({ config: ctx.config, lead, job });
    if (reason) {
      await recordSkip(lead, reason);
      return null;
    }
  }
  // After the stateless gates: it reads the org owner's plan. An org that lost its plan stops dialing here.
  if (!await isHotLeadCallEntitled({ ownerUserId: ctx.orgOwnerUserId })) {
    await recordSkip(lead, 'not_entitled');
    return null;
  }
  const callable = callableLeadPhone(lead.phone, ctx.config);
  if (!('phone' in callable)) return null; // always set: the phone gate refused otherwise
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
    return null;
  }
  return { job, ctx, phone: callable.phone, callerNumber, lead };
}

type Reviewed = NonNullable<Awaited<ReturnType<typeof review>>>;

/**
 * Everything that must hold before a slot is reserved: the kill switch, the gates, somebody on the team available
 * right now (time moves on between the gates and the reservation), and Twilio credentials. Returns null when the
 * job should stop; refusals worth showing on the timeline have been recorded.
 */
async function preflight(job: HotLeadCallJob): Promise<(Reviewed & { candidates: HotLeadCallMember[] }) | null> {
  if (!await isHotLeadCallEnabled()) return null;
  const reviewed = await review(job, job.orgId);
  if (!reviewed) return null;

  const candidates = selectHotLeadCallCandidates(reviewed.ctx.config, new Date());
  if (candidates.length === 0) {
    await recordSkip(reviewed.lead, 'no_one_available');
    return null;
  }

  // Before any slot or record: with no usable Twilio credentials nothing can be dialed, and the lead's single
  // call slot (and the org's caps) must stay unused so a later submission can try again.
  try {
    await getVoiceProvider().ensureCredentials();
  } catch (err) {
    console.warn('[hotLeadCall] voice credentials unavailable', { listId: job.listId, leadId: job.leadId, error: errorText(err) });
    await recordSkip(reviewed.lead, 'credentials_unavailable');
    return null;
  }
  return { ...reviewed, candidates };
}

/**
 * Reserves the lead's slots, then rings the first available member. The slots are taken BEFORE the record is
 * created and given back if it is not: a lead that never dials costs no slot, and a lead refused by a limit
 * leaves no record, so its single call slot stays unused (a repeat submission can retry).
 */
async function reserveAndPlace(job: HotLeadCallJob, reviewed: Reviewed & { candidates: HotLeadCallMember[] }): Promise<void> {
  const { config } = reviewed.ctx;
  const { listId, leadId } = job;
  let slot: Reservation;
  try {
    slot = await reserveCallSlot({ orgId: job.orgId, listId, leadId, phoneE164: reviewed.phone, config });
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
    return;
  }
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
        try {
          created = await store.create(listId, leadId, {
            state: 'dialing', jobKey, startedAt, updatedAt: startedAt, attemptNo: 1, memberId: member.id, triedMemberIds: [member.id],
            leadPhoneMac: leadPhoneMacOf(job.orgId, reviewed.phone), claimToken,
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
