import { createHash } from 'crypto';
import { isSmokeTestLead } from '../utils/smokeTestLead';
import { crmDb } from './db';
import { enqueueJob, markJobComplete, markJobFailed, registerProcessor, startHeartbeat } from './asyncJobQueue';
import { redactPhone } from './whatsappService';
import type { HotLeadCallConfig } from './hotLeadCallConfig';
import { callableLeadPhone } from './hotLeadCallConfig';
import type { LeadOrigin } from './leadNotificationConfig';
import { VoiceCallError, getVoiceProvider, scrubErrorText } from './voice/voiceProvider';
import { buildVoiceWebhookUrl, isWebhookSafeId } from './voice/voiceUrls';
import { isHotLeadCallEnabled } from './voice/hotLeadCallMode';
import { isHotLeadCallEntitled } from './voice/hotLeadCallEntitlement';
import { resolveHotLeadCallContext, type HotLeadCallContext } from './voice/hotLeadCallContext';
import { getLeadCallStore } from './voice/leadCallStore';
import type { LeadCallStore } from './voice/leadCallStore.types';
import { isWithinCallWindow, reserveCallSlot, type Reservation } from './voice/hotLeadCallLimits';
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
const MEMBER_RING_TIMEOUT_SECONDS = 25;
const MINUTE_MS = 60_000;
// Anyone can submit a landing-page form, and again, so refusals must not grow the lead row without bound:
// one `call.skipped` event per distinct reason, and five in all.
const MAX_SKIP_EVENTS_PER_LEAD = 5;
// Two dispatches racing for the same lead: the loser trips the phone marker before the winner's call record
// is visible. One short re-check tells that apart from a genuinely different lead sharing the number.
let sameLeadRecheckMs = 200;

/** Tests only. Pass null to restore the default wait. */
export function setSameLeadRecheckDelayForTests(ms: number | null): void {
  sameLeadRecheckMs = ms ?? 200;
}

const keyOf = (job: HotLeadCallJob): string =>
  createHash('sha256').update(JSON.stringify([job.orgId, job.listId, job.leadId, ...(job.submissionId ? [job.submissionId] : [])])).digest('hex');
const errorText = (err: unknown): string => scrubErrorText(err instanceof Error ? err.message : 'unknown').slice(0, 200);
const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

type LeadRow = NonNullable<Awaited<ReturnType<typeof crmDb.getLeadById>>>;
interface GateInput { config: HotLeadCallConfig; lead: LeadRow; job: HotLeadCallJob }

// Gates that record `call.skipped` when they refuse, cheapest first. Each returns a skip reason or null.
const SKIP_GATES: Array<(g: GateInput) => string | null> = [
  // Enabled configs are validated to have one, but the call must never reach create without it: a skip
  // keeps the lead's single call slot unused.
  ({ config }) => (config.twilioNumber ? null : 'no_caller_number'),
  // The webhooks reject ids outside their strict shape; Twilio would ring the member and every callback would fail.
  ({ job }) => (isWebhookSafeId(job.listId) && isWebhookSafeId(job.leadId) ? null : 'unsafe_id'),
  ({ lead, config }) => {
    const callable = callableLeadPhone(lead.phone, config);
    return 'reason' in callable ? callable.reason : null;
  },
  // Stateless, so it runs in every pass; the limits that count calls run once, just before create. A skip leaves
  // the lead's call slot unused, and the Slack alert goes out regardless.
  ({ config }) => (isWithinCallWindow(config.quietHours, new Date()) ? null : 'outside_quiet_hours'),
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

/** True when this lead already has (or, after one short wait, gets) a call record. */
async function hasCallRecord(store: LeadCallStore, listId: string, leadId: string): Promise<boolean> {
  if (await store.get(listId, leadId)) return true;
  await new Promise((resolve) => setTimeout(resolve, sameLeadRecheckMs));
  return !!(await store.get(listId, leadId));
}

/**
 * Everything that decides whether this lead should ring a team member, cheapest check first. Runs at
 * dispatch and again in the job (state can change in between). Returns null for "do nothing";
 * refusals worth showing on the timeline also record `call.skipped`.
 */
async function review(input: JobInput, expectedOrgId?: string): Promise<{ job: HotLeadCallJob; ctx: HotLeadCallContext; phone: string; lead: LeadRow } | null> {
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
  return 'phone' in callable ? { job, ctx, phone: callable.phone, lead } : null; // always set: the phone gate refused otherwise
}

/**
 * Re-runs the gates, then places the member call at most once. The call record is the at-most-once
 * control: store.create is create-if-absent, so false means a record already exists for this lead and
 * we never dial, and a throw means nothing was dialed and the job fails (the queue row dedupes the
 * same job key). v1 rule: a lead gets one call record ever, so a place_rejected lead is not retried
 * automatically.
 */
export async function processHotLeadCallJob(job: HotLeadCallJob): Promise<void> {
  if (!job || !isNonEmpty(job.orgId) || !isNonEmpty(job.listId) || !isNonEmpty(job.leadId)) throw new Error('Invalid hot lead call job');
  if (!await isHotLeadCallEnabled()) return;
  const reviewed = await review(job, job.orgId);
  if (!reviewed) return;
  const { config } = reviewed.ctx;
  const { listId, leadId } = job;
  const key = keyOf(job);
  const webhook = { listId, leadId, jobKey: key };
  // Built before create: a missing BACKEND_URL must fail the job without using the lead's call slot.
  const url = buildVoiceWebhookUrl('owner', webhook);
  const statusCallbackUrl = buildVoiceWebhookUrl('status', webhook);
  const store = getLeadCallStore();

  // Reserve BEFORE create and give back if create does not win: a lead that never dials costs no slot, and a
  // lead refused by a limit leaves no record, so its single call slot stays unused (a repeat submission can retry).
  let slot: Reservation;
  try {
    slot = await reserveCallSlot({ orgId: job.orgId, phoneE164: reviewed.phone, config });
  } catch (err) {
    // Fail closed (nothing dialed, no record) but leave a trace on the lead: a missing table or secret is an ops problem.
    console.warn('[hotLeadCall] call limits unavailable', { listId, leadId, error: errorText(err) });
    // The timeline write is best-effort: it must never mask the original failure.
    await recordSkip(reviewed.lead, 'limits_unavailable').catch(() => undefined);
    throw err;
  }
  if (!slot.ok) {
    // A repeat submission of a lead that was already called, or a racing dispatch for this same lead, trips the
    // phone marker; the timeline already has (or is about to get) the call.
    if (slot.reason === 'duplicate_phone' && await hasCallRecord(store, listId, leadId)) return;
    await recordSkip(reviewed.lead, slot.reason);
    return;
  }
  const startedAt = new Date().toISOString();
  let created = false;
  try {
    created = await store.create(listId, leadId, { state: 'dialing', jobKey: key, startedAt, updatedAt: startedAt });
  } finally {
    if (!created) await slot.release();
  }
  if (!created) return;

  // If the post-call transition fails the record stays 'dialing'; the first signed member callback adopts the CallSid.
  const settle = async (patch: Parameters<typeof store.transition>[3], event: 'call.initiated' | 'call.failed', detail?: Record<string, string>) => {
    try {
      if (await store.transition(listId, leadId, ['dialing'], patch)) await store.addEvent(listId, leadId, event, detail);
    } catch (err) {
      console.warn('[hotLeadCall] call record not updated', { listId, leadId, error: errorText(err) });
    }
  };

  let memberCallSid: string;
  try {
    ({ callSid: memberCallSid } = await getVoiceProvider().placeCall({
      to: config.destinationPhone,
      from: config.twilioNumber!, // non-null: the no_caller_number gate refused otherwise
      url,
      statusCallbackUrl,
      timeoutSeconds: MEMBER_RING_TIMEOUT_SECONDS,
    }));
  } catch (err) {
    if (err instanceof VoiceCallError && err.placed === 'no') {
      console.warn('[hotLeadCall] member call rejected', { listId, leadId, to: redactPhone(config.destinationPhone) });
      await settle({ state: 'failed', outcome: 'place_rejected' }, 'call.failed', { reason: 'place_rejected' });
    } else {
      // The call may be live: stay non-terminal so the webhooks can still adopt and meter it. Never retried.
      console.warn('[hotLeadCall] member call placement unknown', { listId, leadId, to: redactPhone(config.destinationPhone) });
      await settle({ state: 'dialing', outcome: 'placement_unknown' }, 'call.failed', { reason: 'placement_unknown' });
    }
    return;
  }
  await settle({ state: 'member_ringing', memberCallSid }, 'call.initiated');
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
}
