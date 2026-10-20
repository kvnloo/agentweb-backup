import { createHash } from 'crypto';
import { isSmokeTestLead } from '../utils/smokeTestLead';
import { crmDb } from './db';
import { enqueueJob, markJobComplete, markJobFailed, registerProcessor, startHeartbeat } from './asyncJobQueue';
import type { HotLeadCallConfig } from './hotLeadCallConfig';
import { callableLeadPhone } from './hotLeadCallConfig';
import type { LeadOrigin } from './leadNotificationConfig';
import { isWebhookSafeId } from './voice/voiceUrls';
import { isHotLeadCallEnabled } from './voice/hotLeadCallMode';
import { isHotLeadCallEntitled } from './voice/hotLeadCallEntitlement';
import { resolveHotLeadCallContext, type HotLeadCallContext } from './voice/hotLeadCallContext';
import { getLeadCallStore } from './voice/leadCallStore';
import { isWithinCallWindow, leadPhoneMac, reserveCallSlot, type Reservation } from './voice/hotLeadCallLimits';
import { selectHotLeadCallCandidates } from './hotLeadCallRoster';
import { NEXT_ATTEMPT_SOURCE, processHotLeadCallNextAttempt } from './hotLeadCallAttempts';
import { errorText, placeMemberCall, type PlacementResult } from './hotLeadCallPlacement';
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
const MINUTE_MS = 60_000;
// Anyone can submit a landing-page form, and again, so refusals must not grow the lead row without bound:
// one `call.skipped` event per distinct reason, and five in all.
const MAX_SKIP_EVENTS_PER_LEAD = 5;
const keyOf = (job: HotLeadCallJob): string =>
  createHash('sha256').update(JSON.stringify([job.orgId, job.listId, job.leadId, ...(job.submissionId ? [job.submissionId] : [])])).digest('hex');
const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

type LeadRow = NonNullable<Awaited<ReturnType<typeof crmDb.getLeadById>>>;
interface GateInput { config: HotLeadCallConfig; lead: LeadRow; job: HotLeadCallJob }

// Gates that record `call.skipped` when they refuse, cheapest first. Each returns a skip reason or null.
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
  return 'phone' in callable ? { job, ctx, phone: callable.phone, callerNumber, lead } : null; // always set: the phone gate refused otherwise
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
  if (!await isHotLeadCallEnabled()) return;
  const reviewed = await review(job, job.orgId);
  if (!reviewed) return;
  const { config } = reviewed.ctx;
  const { listId, leadId } = job;
  const key = keyOf(job);
  const store = getLeadCallStore();

  // Re-evaluated now (not taken from the gates): time moves on between the gates and the reservation.
  const candidates = selectHotLeadCallCandidates(config, new Date());
  if (candidates.length === 0) {
    await recordSkip(reviewed.lead, 'no_one_available');
    return;
  }

  // Reserve BEFORE create and give back if create does not win: a lead that never dials costs no slot, and a
  // lead refused by a limit leaves no record, so its single call slot stays unused (a repeat submission can retry).
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
    return;
  }

  let created = false;
  let result: PlacementResult;
  try {
    result = await placeMemberCall({
      orgId: job.orgId, listId, leadId, jobKey: key, config, callerNumber: reviewed.callerNumber, candidates, attemptNo: 1,
      createRecord: async (member) => {
        const startedAt = new Date().toISOString();
        created = await store.create(listId, leadId, {
          state: 'dialing', jobKey: key, startedAt, updatedAt: startedAt, attemptNo: 1, memberId: member.id, triedMemberIds: [member.id],
          leadPhoneMac: leadPhoneMac(job.orgId, reviewed.phone),
        });
        return created;
      },
    });
  } finally {
    // No record means no call: give the lead's slots back (a lost create, every member in cooldown, or an error).
    if (!created) await slot.release();
  }
  if (result === 'none') await recordSkip(reviewed.lead, 'member_cooldown');
}

/** Never rejects to a lead saver. Fire-and-forget right after a successful lead write. */
export async function dispatchHotLeadCall(listId: string, leadId: string, origin?: LeadOrigin, submission?: Submission): Promise<void> {
  try {
    if (!await isHotLeadCallEnabled()) return;
    if (!origin) return;
    const reviewed = await review({ listId, leadId, origin, ...submission });
    if (!reviewed) return;
    const { job } = reviewed;
    const key = keyOf(job);
    const queued = await enqueueJob(SOURCE, key, job, { claimImmediately: true });
    if (queued === 'duplicate') return;
    if (queued !== 'enqueued') throw new Error('Hot lead call queue unavailable');
    const stop = startHeartbeat(SOURCE, key);
    try {
      await processHotLeadCallJob(job);
      await markJobComplete(SOURCE, key);
    } catch (err) {
      await markJobFailed(SOURCE, key, new Error(`Hot lead call failed: ${errorText(err)}`));
    } finally { stop(); }
  } catch (err) {
    console.warn('[hotLeadCall] dispatch failed', { listId, leadId, error: errorText(err) });
  }
}

export function registerHotLeadCallProcessor(): void {
  registerProcessor(SOURCE, processHotLeadCallJob, { maxAttempts: 1 });
  registerProcessor(NEXT_ATTEMPT_SOURCE, processHotLeadCallNextAttempt, { maxAttempts: 1 });
}
