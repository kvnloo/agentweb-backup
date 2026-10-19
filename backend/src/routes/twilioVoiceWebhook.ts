/**
 * Twilio voice webhooks for the hot-lead auto-call (ENG-2271). Mounted at /api/webhooks/twilio-voice
 * with no auth middleware: Twilio is the caller, and every request proves itself with X-Twilio-Signature.
 *
 * Call shape: Twilio rings the owner (placed by the orchestrator) -> /owner prompts "press 1" ->
 * /gather bridges to the lead with <Dial><Number> -> /dial reports how the bridge ended. /status
 * receives the per-leg call-progress callbacks and is the ONLY place usage is metered.
 *
 * Every endpoint runs the same guard: credentials loaded (else 503) -> signature over
 * the URL rebuilt from BACKEND_URL (else 401) -> strict query shape -> record + jobKey + CallSid match.
 * The body is parsed by a local 64kb flat-form parser first, whatever its content type; one that is too large
 * or unreadable is answered 413/400 there and never reaches the app's global error handler.
 * A TwiML endpoint (/owner, /gather, /dial) answers a request that passes the signature but does not
 * belong to a live call with a bare hangup and HTTP 200 (so Twilio does not retry), writing nothing.
 * /status answers such a request with an empty 200; it answers 500 only when a leg ended but no owner
 * can be found to bill or metering lost its race repeatedly (nothing partial is written), or on an unexpected
 * error. Twilio does NOT retry a 5xx by default, so the status callback URLs carry a retry override (see
 * voiceUrls.ts); every handler is idempotent on a redelivery (meteredLegs winner rule).
 *
 * Record lifecycle (all moves go through LeadCallStore.transition with explicit `from` sets). The
 * orchestrator creates the record in 'dialing' BEFORE calling Twilio and moves it to owner_ringing
 * (with ownerCallSid) afterwards; if that move has not landed yet, /owner and the owner /status adopt
 * the CallSid from the signed callback (same jobKey only) and move the record to owner_ringing themselves,
 * so the orchestrator's late settle (from 'dialing') loses. One record per lead, ever.
 *   dialing/owner_ringing -> owner_answered (/owner) -> bridging (/gather, digit 1) -> connected (lead answered)
 *   -> finished (last leg's final /status).
 * A terminal record can no longer be written, so a leg is metered (meteredLegs) while the record is still
 * live, and the LAST leg to be metered performs the terminal transition. If a leg's final callback never
 * arrives the record stays non-terminal: WP6/ops needs a cleanup for records stuck in bridging/connected
 * (no cron is added here).
 *
 * Decisions that do not change `state` (owner declined, lead did not answer) are made once through marker
 * entries in `lastSequence`: see HotLeadCallRecord.lastSequence.
 */

import express from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { crmDb } from '../services/db';
import { getVoiceProvider } from '../services/voice/voiceProvider';
import { voiceWebhookBaseUrl, buildVoiceWebhookUrl, isWebhookSafeId } from '../services/voice/voiceUrls';
import { isHotLeadCallEnabled } from '../services/voice/hotLeadCallMode';
import { resolveHotLeadCallContext, type HotLeadCallContext } from '../services/voice/hotLeadCallContext';
import { getLeadCallStore } from '../services/voice/leadCallStore';
import type { HotLeadCallEventType, HotLeadCallLeg, HotLeadCallRecord, HotLeadCallState } from '../services/voice/leadCallStore.types';
import { recordCallUsage } from '../services/voice/voiceUsage';
import { connectTwiml, hangupTwiml, leadUnreachableTwiml, ownerPromptTwiml } from '../services/voice/twiml';
import { callableLeadPhone } from '../services/hotLeadCallConfig';

// type: () => true so a JSON or other content type is limited and parsed here too, instead of falling
// through to the global 50mb express.json (the same trick as the unipile and tracker parsers).
const flatFormParser = express.urlencoded({ limit: '64kb', extended: false, type: () => true });

/**
 * Twilio posts small flat form bodies. app.ts mounts this BEFORE the global 50mb extended parser (which
 * skips a body that is already parsed), so this route never accepts a large body or `a[b]=1` nesting.
 * Parse errors are answered here: left to next(err) they would reach the global error handler, which logs
 * and reports every unauthenticated bad request.
 */
export const twilioVoiceBodyParser: RequestHandler = (req, res, next) => {
  flatFormParser(req, res, (err?: unknown) => {
    if (!err) return next();
    const tooLarge = typeof err === 'object' && err !== null && 'status' in err && err.status === 413;
    res.status(tooLarge ? 413 : 400).end();
  });
};

const router = express.Router();

interface CallQuery {
  listId: string;
  leadId: string;
  jobKey: string;
  leg: HotLeadCallLeg;
}
type FormParams = Record<string, string>;

const CALL_SID_SHAPE = /^CA[A-Za-z0-9]{8,40}$/;
const QUERY_KEYS = new Set(['listId', 'leadId', 'jobKey', 'leg']);

const LIVE_STATES: HotLeadCallState[] = ['dialing', 'owner_ringing', 'owner_answered', 'bridging', 'connected'];
const TERMINAL_CALL_STATUSES = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled']);
const LEAD_NOT_REACHED = new Set(['no-answer', 'busy', 'failed', 'canceled']);
const LEAD_REACHED = new Set(['completed', 'answered']);
const MAX_TRANSITION_ATTEMPTS = 3;

// Marker entries in `lastSequence` that make a decision first-writer-wins: see HotLeadCallRecord.lastSequence.
const decisionKey = (ownerSid: string, step: 'gather' | 'dial'): string => `${ownerSid}#${step}`;
const errorName = (err: unknown): string => (err instanceof Error ? err.name : 'unknown error');

const sendXml = (res: Response, xml: string): void => {
  res.status(200).type('text/xml').send(xml);
};
const sendHangup = (res: Response): void => sendXml(res, hangupTwiml());

function parseQuery(req: Request): CallQuery | null {
  if (Object.keys(req.query).some((k) => !QUERY_KEYS.has(k))) return null;
  const { listId, leadId, jobKey, leg } = req.query;
  if (typeof listId !== 'string' || typeof leadId !== 'string' || typeof jobKey !== 'string') return null;
  if (![listId, leadId, jobKey].every(isWebhookSafeId)) return null;
  // The orchestrator's owner-leg status URL carries no leg; only the lead <Number> callback adds leg=lead.
  if (leg !== undefined && leg !== 'owner' && leg !== 'lead') return null;
  return { listId, leadId, jobKey, leg: leg ?? 'owner' };
}

function paramsOf(req: Request): FormParams | null {
  const body: unknown = req.body ?? {};
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const params: FormParams = {};
  for (const [k, v] of Object.entries(body)) {
    if (typeof v !== 'string') return null; // Twilio only sends flat strings, so this cannot be a genuine signed body
    params[k] = v;
  }
  return params;
}

/**
 * The record this callback belongs to (same job), or null. ownerCallSid may still be missing: the
 * orchestrator creates the record in 'dialing' before calling Twilio and records the sid afterwards.
 */
async function loadRecord(q: CallQuery): Promise<HotLeadCallRecord | null> {
  const record = await getLeadCallStore().get(q.listId, q.leadId);
  return record && record.jobKey === q.jobKey ? record : null;
}

/**
 * Owner-leg callbacks only. While the record is still 'dialing' (the orchestrator's post-call
 * transition has not landed, or failed) the first signed owner-leg callback for this job supplies
 * the owner CallSid. The jobKey was already matched by loadRecord and the signature covers it.
 * Adoption moves the record to owner_ringing with the sid. That dialing -> owner_ringing transition is the
 * single-writer guard: exactly one caller wins it, so two racing callbacks cannot overwrite each other's
 * sid, and the orchestrator's own settle (also from 'dialing') loses and cannot write a second
 * call.initiated. After this call the caller compares against whichever sid the re-read shows.
 * A record stuck in 'dialing'/'owner_ringing' (no callback ever) needs an ops cleanup, see header.
 */
async function withOwnerSid(q: CallQuery, record: HotLeadCallRecord, callSid: string | undefined): Promise<HotLeadCallRecord> {
  if (record.ownerCallSid || record.state !== 'dialing' || !callSid) return record;
  const store = getLeadCallStore();
  // Adoption moves the record out of 'dialing', so the orchestrator's later settle loses and only this path
  // writes call.initiated.
  if (await store.transition(q.listId, q.leadId, ['dialing'], { state: 'owner_ringing', ownerCallSid: callSid })) {
    await store.addEvent(q.listId, q.leadId, 'call.initiated');
  }
  return (await store.get(q.listId, q.leadId)) ?? record; // a lost race still shows whichever sid won
}

const sidOf = (body: FormParams, field: string): string | undefined => (CALL_SID_SHAPE.test(body[field] ?? '') ? body[field] : undefined);

/** Owner id for metering. Not tied to the config being enabled: a call placed earlier must still be billed. */
async function meteringUserId(listId: string, ctx: HotLeadCallContext | null): Promise<string | null> {
  if (ctx) return ctx.ownerUserId;
  const list = await crmDb.getLeadListById(listId, { consistentRead: true });
  return list && list.listId === listId && typeof list.userId === 'string' && list.userId ? list.userId : null;
}

type Handler = (req: Request, res: Response, q: CallQuery, body: FormParams) => Promise<void>;

interface ErrorReplies {
  /** The signed request is not for a call we can act on (malformed query). Never retried by Twilio. */
  invalid: (res: Response) => void;
  /** An unexpected failure while handling it. */
  failed: (res: Response) => void;
}

function guarded(handler: Handler, replies: ErrorReplies) {
  return async (req: Request, res: Response): Promise<void> => {
    const provider = getVoiceProvider();
    let url: string;
    try {
      await provider.ensureCredentials();
      url = `${voiceWebhookBaseUrl()}${req.originalUrl}`;
    } catch (err) {
      // Cannot verify right now, so nothing is processed. Only /status carries a retry override.
      console.error('[twilio-voice] cannot verify callback:', errorName(err));
      res.status(503).end();
      return;
    }
    const body = paramsOf(req);
    const signature = req.header('X-Twilio-Signature');
    if (!body || !provider.validateSignature({ url, params: body, signature })) {
      res.status(401).end();
      return;
    }
    const q = parseQuery(req);
    if (!q) {
      replies.invalid(res);
      return;
    }
    try {
      await handler(req, res, q, body);
    } catch (err) {
      // Name only: an error message from a lower layer may echo request data.
      console.error('[twilio-voice] handler failed:', errorName(err));
      if (!res.headersSent) replies.failed(res);
    }
  };
}

const twimlReplies: ErrorReplies = { invalid: sendHangup, failed: sendHangup };
const ack = (res: Response): void => {
  res.status(200).end();
};
const serverError = (res: Response): void => {
  res.status(500).end();
};
const statusReplies: ErrorReplies = { invalid: ack, failed: serverError };

/**
 * The owner picked up but the call may no longer proceed (kill switch off, config disabled or invalid).
 * Recording the outcome keeps the owner leg's final callback from relabelling it 'owner_no_answer'; the
 * leg is still metered as usual. The decision marker is only written from /gather.
 */
async function abortCall(q: CallQuery, record: HotLeadCallRecord, from: HotLeadCallState[]): Promise<void> {
  const store = getLeadCallStore();
  // Only /gather's decision marker applies here: from /owner the call has not reached the gather step yet.
  const decision = record.state === 'owner_answered' && record.ownerCallSid ? { [decisionKey(record.ownerCallSid, 'gather')]: 1 } : undefined;
  if (await store.transition(q.listId, q.leadId, from, { state: 'owner_answered', outcome: 'aborted', lastSequence: decision })) {
    await store.addEvent(q.listId, q.leadId, 'call.failed', { reason: 'aborted' });
  }
}

/** Live config + kill switch, else null (the caller hangs up). */
async function liveContext(q: CallQuery): Promise<HotLeadCallContext | null> {
  if (!(await isHotLeadCallEnabled())) return null;
  return resolveHotLeadCallContext(q.listId);
}

// ── /owner: the owner picked up ─────────────────────────────────────────────

router.post('/owner', guarded(async (_req, res, q, body) => {
  const ctx = await liveContext(q);
  const loaded = await loadRecord(q);
  const record = loaded && (await withOwnerSid(q, loaded, sidOf(body, 'CallSid')));
  // A missing record is deliberately NOT adopted (created here): the orchestrator creates the record
  // before it dials, so no record means this callback is not for a call we placed, and a call without
  // a record could never be metered.
  if (!record || !record.ownerCallSid || body.CallSid !== record.ownerCallSid) return sendHangup(res);

  const awaitingAnswer = record.state === 'owner_ringing' || record.state === 'dialing';
  if (!ctx) {
    if (awaitingAnswer) await abortCall(q, record, ['owner_ringing', 'dialing']);
    return sendHangup(res);
  }
  const store = getLeadCallStore();
  if (awaitingAnswer) {
    // Won exactly once; the event is written only by the winner.
    if (await store.transition(q.listId, q.leadId, ['owner_ringing', 'dialing'], { state: 'owner_answered' })) {
      await store.addEvent(q.listId, q.leadId, 'call.owner_answered');
    }
  } else if (record.state !== 'owner_answered') {
    return sendHangup(res);
  }
  // A re-fetch while already owner_answered (Twilio retry) gets the same prompt again, with no second event.
  sendXml(res, ownerPromptTwiml({ announcedName: ctx.config.announcedName, gatherUrl: buildVoiceWebhookUrl('gather', q) }));
}, twimlReplies));

// ── /gather: the owner pressed a key ────────────────────────────────────────

/** The lead's number from the lead row, re-validated now. Never from the URL or the request body. */
async function leadPhoneFor(q: CallQuery, ctx: HotLeadCallContext): Promise<string | null> {
  const lead = await crmDb.getLeadById(q.listId, q.leadId, { consistentRead: true });
  const callable = callableLeadPhone(lead?.phone, ctx.config);
  return 'phone' in callable ? callable.phone : null;
}

router.post('/gather', guarded(async (_req, res, q, body) => {
  const ctx = await liveContext(q);
  const record = await loadRecord(q);
  if (!record?.ownerCallSid || body.CallSid !== record.ownerCallSid || record.state !== 'owner_answered') return sendHangup(res);
  if (!ctx) {
    await abortCall(q, record, ['owner_answered']);
    return sendHangup(res);
  }

  const store = getLeadCallStore();
  // One decision per call, whatever the key: a replay or a later different digit cannot reverse it.
  const decision = { [decisionKey(record.ownerCallSid, 'gather')]: 1 };

  if (body.Digits !== '1') {
    if (await store.transition(q.listId, q.leadId, ['owner_answered'], { state: 'owner_answered', outcome: 'owner_declined', lastSequence: decision })) {
      await store.addEvent(q.listId, q.leadId, 'call.owner_declined');
    }
    return sendHangup(res);
  }

  const leadE164 = await leadPhoneFor(q, ctx);
  if (!leadE164 || !ctx.config.twilioNumber) {
    if (await store.transition(q.listId, q.leadId, ['owner_answered'], { state: 'owner_answered', outcome: 'lead_phone_invalid', lastSequence: decision })) {
      await store.addEvent(q.listId, q.leadId, 'call.failed', { reason: 'lead_phone_invalid' });
    }
    return sendXml(res, leadUnreachableTwiml());
  }

  // Built before the transition so that a builder that throws cannot leave the record 'bridging' with
  // the owner hung up.
  const connect = connectTwiml({
    twilioNumber: ctx.config.twilioNumber,
    leadE164,
    dialUrl: buildVoiceWebhookUrl('dial', q),
    statusUrl: buildVoiceWebhookUrl('status', q, { leg: 'lead' }),
  });
  // Only the winner dials the lead; a replayed "1" gets a hangup instead of a second bridge.
  if (!(await store.transition(q.listId, q.leadId, ['owner_answered'], { state: 'bridging', lastSequence: decision }))) return sendHangup(res);
  sendXml(res, connect);
}, twimlReplies));

// ── /dial: the <Dial> to the lead ended ─────────────────────────────────────

router.post('/dial', guarded(async (_req, res, q, body) => {
  const record = await loadRecord(q);
  if (!record?.ownerCallSid || body.CallSid !== record.ownerCallSid) return sendHangup(res);

  const store = getLeadCallStore();
  const ownerSid = record.ownerCallSid;
  const status = body.DialCallStatus ?? '';
  // DialCallSid is the lead leg; keep it only if nothing contradicts it.
  const dialSid = sidOf(body, 'DialCallSid');
  const leadCallSid = dialSid && dialSid !== ownerSid && !record.leadCallSid ? dialSid : undefined;

  if (LEAD_REACHED.has(status)) {
    // Normally already connected by the lead's "answered" status callback; this covers it arriving late or never.
    if (await store.transition(q.listId, q.leadId, ['bridging'], { state: 'connected', leadCallSid })) {
      await store.addEvent(q.listId, q.leadId, 'call.connected');
    }
    return sendHangup(res);
  }
  if (LEAD_NOT_REACHED.has(status)) {
    const first = await store.transition(q.listId, q.leadId, ['bridging'], {
      state: 'bridging',
      outcome: 'lead_no_answer',
      leadCallSid,
      lastSequence: { [decisionKey(ownerSid, 'dial')]: 1 },
    });
    if (first) await store.addEvent(q.listId, q.leadId, 'call.lead_no_answer', { dialStatus: status });
    return sendXml(res, leadUnreachableTwiml());
  }
  sendHangup(res);
}, twimlReplies));

// ── /status: per-leg call progress (metering) ───────────────────────────────

/**
 * Whether a lead leg was (or may be) dialed and so must be metered before the record can finish. After
 * /dial reported no-answer with no DialCallSid, no lead call was ever created, so none is awaited.
 */
function leadLegExpected(record: HotLeadCallRecord): boolean {
  if (record.state !== 'bridging' && record.state !== 'connected') return false;
  return !(record.leadCallSid === undefined && record.outcome === 'lead_no_answer');
}

function everyDialedLegMetered(record: HotLeadCallRecord): boolean {
  const metered = record.meteredLegs ?? [];
  return metered.includes('owner') && (!leadLegExpected(record) || metered.includes('lead'));
}

async function finishIfComplete(q: CallQuery): Promise<void> {
  const store = getLeadCallStore();
  const record = await store.get(q.listId, q.leadId);
  if (!record || record.jobKey !== q.jobKey || !LIVE_STATES.includes(record.state) || !everyDialedLegMetered(record)) return;
  // Still bridging with no /dial result: we cannot say whether the lead picked up.
  const outcome = decidedOutcome(record) ?? (record.state === 'bridging' ? 'bridge_unconfirmed' : 'completed');
  if (await store.transition(q.listId, q.leadId, LIVE_STATES, { state: 'finished', outcome })) {
    await store.addEvent(q.listId, q.leadId, 'call.completed', { outcome });
  }
}

/**
 * The orchestrator marks an ambiguous placement with outcome 'placement_unknown' while the record stays
 * 'dialing': that is information, not a decision, so it must not suppress the real owner outcome.
 */
const decidedOutcome = (record: HotLeadCallRecord): string | undefined =>
  record.outcome === 'placement_unknown' ? undefined : record.outcome;

/** Outcome and timeline event when the owner leg ends before the owner chose anything. */
function ownerLegOutcome(current: HotLeadCallRecord, leg: HotLeadCallLeg): { outcome: string; event: HotLeadCallEventType } | undefined {
  if (leg !== 'owner' || decidedOutcome(current)) return undefined;
  if (current.state === 'dialing' || current.state === 'owner_ringing') return { outcome: 'owner_no_answer', event: 'call.owner_no_answer' };
  // Hung up on the prompt (the Gather timeout falls through without posting to /gather).
  if (current.state === 'owner_answered') return { outcome: 'owner_declined', event: 'call.owner_declined' };
  return undefined;
}

interface LegCallback {
  q: CallQuery;
  callSid: string;
  sequence: number | undefined;
  durationSeconds: number;
}

/** Lead leg progress: remember its sid and flag the bridge as connected when it is answered. */
async function handleProgress(cb: LegCallback, record: HotLeadCallRecord, callStatus: string): Promise<void> {
  const { q, callSid, sequence } = cb;
  if (q.leg !== 'lead' || (record.state !== 'bridging' && record.state !== 'connected')) return;
  const store = getLeadCallStore();
  const answered = callStatus === 'in-progress' && record.state === 'bridging';
  const won = await store.transition(q.listId, q.leadId, [record.state], {
    state: answered ? 'connected' : record.state,
    leadCallSid: record.leadCallSid ? undefined : callSid,
    lastSequence: sequence === undefined ? undefined : { [callSid]: sequence },
  });
  if (won && answered) await store.addEvent(q.listId, q.leadId, 'call.connected');
}

/**
 * Terminal status for one leg: record it as metered in ONE transition and bill only if this caller
 * won it. Returns 'no-owner-to-bill' when nothing could be written because nobody can be billed, and
 * 'gave-up' when every attempt lost its transition (the caller answers 5xx so the retry override redelivers).
 */
async function meterLeg(cb: LegCallback): Promise<'done' | 'no-owner-to-bill' | 'gave-up'> {
  const { q, callSid, sequence } = cb;
  const store = getLeadCallStore();
  let billedUserId: string | null | undefined;
  for (let attempt = 0; attempt < MAX_TRANSITION_ATTEMPTS; attempt++) {
    const current = await store.get(q.listId, q.leadId);
    if (!current || current.jobKey !== q.jobKey || !LIVE_STATES.includes(current.state)) return 'done';
    if ((current.meteredLegs ?? []).includes(q.leg)) return 'done';
    if (sequence !== undefined && (current.lastSequence?.[callSid] ?? -1) >= sequence) return 'done';

    if (billedUserId === undefined) billedUserId = await meteringUserId(q.listId, await resolveHotLeadCallContext(q.listId));
    if (!billedUserId) {
      console.error('[twilio-voice] no owner to bill for list', q.listId);
      return 'no-owner-to-bill';
    }

    const ended = ownerLegOutcome(current, q.leg);
    const won = await store.transition(q.listId, q.leadId, [current.state], {
      state: current.state,
      meteredLegs: [q.leg],
      leadCallSid: q.leg === 'lead' && !current.leadCallSid ? callSid : undefined,
      outcome: ended?.outcome,
      lastSequence: sequence === undefined ? undefined : { [callSid]: sequence },
    });
    if (!won) continue; // state moved under us (or a replay): look again

    if (ended) await store.addEvent(q.listId, q.leadId, ended.event);
    try {
      await recordCallUsage({ userId: billedUserId, callSid, leg: q.leg, durationSeconds: cb.durationSeconds });
    } catch (err) {
      console.error('[twilio-voice] metering failed:', errorName(err));
    }
    return 'done';
  }
  console.error('[twilio-voice] metering gave up after retries:', q.leg);
  return 'gave-up';
}

router.post('/status', guarded(async (_req, res, q, body) => {
  const loaded = await loadRecord(q);
  const callSid = sidOf(body, 'CallSid');
  if (!loaded || !callSid) return ack(res);
  const callStatus = body.CallStatus ?? '';
  const cb: LegCallback = {
    q,
    callSid,
    sequence: /^\d{1,9}$/.test(body.SequenceNumber ?? '') ? Number(body.SequenceNumber) : undefined,
    // Number() of an absent field is NaN on purpose: recordCallUsage warns instead of billing 0.
    durationSeconds: Number(body.CallDuration),
  };

  const record = q.leg === 'owner' ? await withOwnerSid(q, loaded, callSid) : loaded;
  const ownerSid = record.ownerCallSid;
  if (!ownerSid) return ack(res);
  if (q.leg === 'owner') {
    if (callSid !== ownerSid) return ack(res);
  } else if (body.ParentCallSid !== ownerSid || callSid === ownerSid || (record.leadCallSid && record.leadCallSid !== callSid)) {
    return ack(res);
  }

  if (!TERMINAL_CALL_STATUSES.has(callStatus)) {
    await handleProgress(cb, record, callStatus);
    return ack(res);
  }
  // Nothing partial is left behind in either case, so the redelivery can still meter the leg.
  if ((await meterLeg(cb)) !== 'done') return serverError(res);
  // Whichever leg is metered last finishes the call (also heals a crash between the two steps).
  await finishIfComplete(q);
  ack(res);
}, statusReplies));

export default router;
