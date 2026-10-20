/**
 * Twilio voice webhooks for the hot-lead auto-call (ENG-2271). Mounted at /api/webhooks/twilio-voice
 * with no auth middleware: Twilio is the caller, and every request proves itself with X-Twilio-Signature.
 *
 * Call shape: Twilio rings a team member (placed by the orchestrator) -> /owner prompts "press 1" ->
 * /gather dials the lead with <Dial><Number url=/screen> -> the lead answers and /screen asks them to press 1
 * -> /screen-result (a digit of 1 lets Twilio bridge the two calls) -> /dial reports how the bridge ended
 * (DialBridged tells a conversation from a lead who screened themselves out). /status receives the per-leg
 * call-progress callbacks and is the ONLY place usage is metered.
 *
 * Every endpoint runs the same guard: credentials loaded (else 503) -> signature over
 * the URL rebuilt from BACKEND_URL (else 401) -> strict query shape -> record + jobKey + CallSid match.
 * The body is parsed by a local 64kb flat-form parser first, whatever its content type; one that is too large
 * or unreadable is answered 413/400 there and never reaches the app's global error handler.
 * A TwiML endpoint (/owner, /gather, /screen, /screen-result, /dial) answers a request that passes the signature but does not
 * belong to a live call with a bare hangup and HTTP 200 (so Twilio does not retry), writing nothing.
 * /status answers such a request with an empty 200; it answers 500 only when a leg ended but nobody
 * can be found to bill or metering lost its race repeatedly (nothing partial is written), or on an unexpected
 * error. Twilio does NOT retry a 5xx by default, so the status callback URLs carry a retry override (see
 * voiceUrls.ts); every handler is idempotent on a redelivery (meteredLegs winner rule).
 *
 * Record lifecycle (all moves go through LeadCallStore.transition with explicit `from` sets). The
 * orchestrator creates the record in 'dialing' BEFORE calling Twilio and moves it to member_ringing
 * (with memberCallSid) afterwards; if that move has not landed yet, /owner and the member /status adopt
 * the CallSid from the signed callback (same jobKey only) and move the record to member_ringing themselves,
 * so the orchestrator's late settle (from 'dialing') loses. One record per lead, ever.
 *   dialing/member_ringing -> member_answered (/owner) -> bridging (/gather, digit 1) -> connected (the lead
 *   pressed 1 at /screen-result, or /dial reports DialBridged=true) -> finished (last leg's final /status).
 * A member leg that ends without the member taking the lead (declined, ignored the prompt, no answer, busy,
 * failed, canceled) is metered and moves the record to between_attempts in ONE transition; the next-attempt
 * seam is then asked for another member, and when it refuses the record finishes. Only the CURRENT attempt's
 * member leg (body CallSid === record.memberCallSid) is acted on; a callback for an earlier attempt's sid is
 * acknowledged and writes nothing, because that attempt was metered before the next one could start.
 * A terminal record can no longer be written, so a leg is metered (meteredLegs) while the record is still
 * live, and the LAST leg to be metered performs the terminal transition. If a leg's final callback never
 * arrives the record stays non-terminal: records stuck in bridging/connected need an ops cleanup (no cron is
 * added here). A record left in between_attempts heals: Twilio redelivers that leg's final callback, which asks for
 * the next attempt again. Metering and finishing live in services/voice/callFinalisation.ts.
 *
 * Decisions that do not change `state` (member declined, lead did not answer) are made once through marker
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
import type { HotLeadCallEventType, HotLeadCallPatch, HotLeadCallRecord, HotLeadCallState } from '../services/voice/leadCallStore.types';
import {
  decisionKey, errorName, finishIfComplete, meterLeg, nextAttemptOrFinish, type CallQuery, type LegCallback,
} from '../services/voice/callFinalisation';
import {
  bridgeTwiml, connectTwiml, hangupTwiml, leadDeclinedTwiml, leadPhoneChangedTwiml, leadScreenTwiml, leadUnreachableTwiml, memberPromptTwiml,
} from '../services/voice/twiml';
import { leadPhoneMacOf } from '../services/voice/leadPhoneMac';
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

type FormParams = Record<string, string>;

const CALL_SID_SHAPE = /^CA[A-Za-z0-9]{8,40}$/;
const QUERY_KEYS = new Set(['listId', 'leadId', 'jobKey', 'leg']);

const TERMINAL_CALL_STATUSES = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled']);
const LEAD_NOT_REACHED = new Set(['no-answer', 'busy', 'failed']);
const DIAL_ENDED_AFTER_ANSWER = new Set(['completed', 'answered']);
// Written together with leadCallSid by /screen: the first writer wins the right to name the lead leg.
const LEAD_SID_ADOPTED = 'lead#adopt';

const sendXml = (res: Response, xml: string): void => {
  res.status(200).type('text/xml').send(xml);
};
const sendHangup = (res: Response): void => sendXml(res, hangupTwiml());

function parseQuery(req: Request): CallQuery | null {
  if (Object.keys(req.query).some((k) => !QUERY_KEYS.has(k))) return null;
  const { listId, leadId, jobKey, leg } = req.query;
  if (typeof listId !== 'string' || typeof leadId !== 'string' || typeof jobKey !== 'string') return null;
  if (![listId, leadId, jobKey].every(isWebhookSafeId)) return null;
  // The orchestrator's member-leg status URL carries no leg; only the lead <Number> callback adds leg=lead.
  if (leg !== undefined && leg !== 'member' && leg !== 'lead') return null;
  return { listId, leadId, jobKey, leg: leg ?? 'member' };
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
 * The record this callback belongs to (same job), or null. memberCallSid may still be missing: the
 * orchestrator creates the record in 'dialing' before calling Twilio and records the sid afterwards.
 */
async function loadRecord(q: CallQuery): Promise<HotLeadCallRecord | null> {
  const record = await getLeadCallStore().get(q.listId, q.leadId);
  return record && record.jobKey === q.jobKey ? record : null;
}

/**
 * One decision of a webhook: the conditional move, and the timeline event only for the caller that won it.
 * Returns whether this caller won; a replay or a lost race writes nothing.
 */
async function decide(
  q: CallQuery, from: HotLeadCallState[], patch: HotLeadCallPatch, event?: HotLeadCallEventType, detail?: Record<string, string>,
): Promise<boolean> {
  const store = getLeadCallStore();
  if (!await store.transition(q.listId, q.leadId, from, patch)) return false;
  if (event) await store.addEvent(q.listId, q.leadId, event, detail);
  return true;
}

type MemberLegRecord = HotLeadCallRecord & { memberCallSid: string };

/**
 * The record of this call when the signed callback is on the member leg the record is on (body CallSid ===
 * record.memberCallSid), else null and the caller hangs up. `adopt` lets the callback that names a member leg
 * the record does not know yet (see withMemberSid) become that leg first.
 */
async function loadMemberLegRecord(q: CallQuery, body: FormParams, adopt = false): Promise<MemberLegRecord | null> {
  const loaded = await loadRecord(q);
  const record = loaded && adopt ? await withMemberSid(q, loaded, sidOf(body, 'CallSid')) : loaded;
  return record?.memberCallSid && body.CallSid === record.memberCallSid ? { ...record, memberCallSid: record.memberCallSid } : null;
}

/**
 * Member-leg callbacks only. While the record is still 'dialing' (the orchestrator's post-call
 * transition has not landed, or failed) the first signed member-leg callback for this job supplies
 * the member CallSid. The jobKey was already matched by loadRecord and the signature covers it.
 * Adoption moves the record to member_ringing with the sid. That dialing -> member_ringing transition is the
 * single-writer guard: exactly one caller wins it, so two racing callbacks cannot overwrite each other's
 * sid, and the orchestrator's own settle (also from 'dialing') loses and cannot write a second
 * call.initiated. After this call the caller compares against whichever sid the re-read shows.
 * A record stuck in 'dialing'/'member_ringing' (no callback ever) needs an ops cleanup, see header.
 */
async function withMemberSid(q: CallQuery, record: HotLeadCallRecord, callSid: string | undefined): Promise<HotLeadCallRecord> {
  if (record.memberCallSid || record.state !== 'dialing' || !callSid) return record;
  // A next attempt that is still being placed has no sid either (the reset removed it), but a late callback of an
  // earlier attempt's call must not be taken for it: every earlier member leg left a marker behind.
  if (alreadyHandled(record, callSid)) return record;
  // Adoption moves the record out of 'dialing', so the orchestrator's later settle loses and only this path
  // writes call.initiated.
  await decide(q, ['dialing'], { state: 'member_ringing', memberCallSid: callSid }, 'call.initiated');
  return (await getLeadCallStore().get(q.listId, q.leadId)) ?? record; // a lost race still shows whichever sid won
}

/** Whether a call this record already dealt with (metered, or a decision taken on it) carries this sid. */
const alreadyHandled = (record: HotLeadCallRecord, callSid: string): boolean =>
  Object.keys(record.lastSequence ?? {}).some((key) => key.split('#')[0] === callSid);

const sidOf = (body: FormParams, field: string): string | undefined => (CALL_SID_SHAPE.test(body[field] ?? '') ? body[field] : undefined);

type Handler = (req: Request, res: Response, q: CallQuery, body: FormParams) => Promise<void>;

interface ErrorReplies {
  /** The signed request is not for a call we can act on (malformed query). Never retried by Twilio. */
  invalid: (res: Response) => void;
  /** An unexpected failure while handling it. */
  failed: (res: Response) => void;
}

// The endpoints are public, so a broken credentials secret is hit by every unauthenticated request: log it once per window.
const CANNOT_VERIFY_LOG_WINDOW_MS = 5_000;
let cannotVerifyLoggedAt = 0;

function guarded(handler: Handler, replies: ErrorReplies) {
  return async (req: Request, res: Response): Promise<void> => {
    const provider = getVoiceProvider();
    let url: string;
    try {
      await provider.ensureCredentials();
      url = `${voiceWebhookBaseUrl()}${req.originalUrl}`;
    } catch (err) {
      // Cannot verify right now, so nothing is processed. Only /status carries a retry override.
      if (Date.now() - cannotVerifyLoggedAt >= CANNOT_VERIFY_LOG_WINDOW_MS) {
        cannotVerifyLoggedAt = Date.now();
        console.error('[twilio-voice] cannot verify callback:', errorName(err));
      }
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
 * The member picked up but the call may no longer proceed (kill switch off, config disabled or invalid, or the member removed or no longer verified).
 * Recording the outcome keeps the member leg's final callback from relabelling it 'member_no_answer'; the
 * leg is still metered as usual. The decision marker is only written from /gather.
 */
async function abortCall(q: CallQuery, record: HotLeadCallRecord, from: HotLeadCallState[]): Promise<void> {
  // Only /gather's decision marker applies here: from /owner the call has not reached the gather step yet.
  const decision = record.state === 'member_answered' && record.memberCallSid ? { [decisionKey(record.memberCallSid, 'gather')]: 1 } : undefined;
  await decide(q, from, { state: 'member_answered', outcome: 'aborted', lastSequence: decision }, 'call.failed', { reason: 'aborted' });
}

/**
 * Live config + kill switch, else null (the caller hangs up). A call whose member has since been removed from
 * the team or lost their verification (phone changed) is no longer live either: nobody should be connected
 * to a lead on a number the org no longer vouches for.
 */
async function liveContext(q: CallQuery, record: HotLeadCallRecord | null): Promise<HotLeadCallContext | null> {
  if (!(await isHotLeadCallEnabled())) return null;
  const ctx = await resolveHotLeadCallContext(q.listId);
  if (ctx && record && !ctx.config.team.some((m) => m.id === record.memberId && m.verifiedAt)) return null;
  return ctx;
}

// ── /owner: the member picked up ─────────────────────────────────────────────

router.post('/owner', guarded(async (_req, res, q, body) => {
  // A missing record is deliberately NOT adopted (created here): the orchestrator creates the record
  // before it dials, so no record means this callback is not for a call we placed, and a call without
  // a record could never be metered.
  const record = await loadMemberLegRecord(q, body, true);
  if (!record) return sendHangup(res);
  const ctx = await liveContext(q, record);

  const awaitingAnswer = record.state === 'member_ringing' || record.state === 'dialing';
  if (!ctx) {
    if (awaitingAnswer) await abortCall(q, record, ['member_ringing', 'dialing']);
    return sendHangup(res);
  }
  if (awaitingAnswer) {
    // Won exactly once; the event is written only by the winner.
    await decide(q, ['member_ringing', 'dialing'], { state: 'member_answered' }, 'call.member_answered');
  } else if (record.state !== 'member_answered') {
    return sendHangup(res);
  }
  // A re-fetch while already member_answered (Twilio retry) gets the same prompt again, with no second event.
  sendXml(res, memberPromptTwiml({ announcedName: ctx.config.announcedName, gatherUrl: buildVoiceWebhookUrl('gather', q) }));
}, twimlReplies));

// ── /gather: the member pressed a key ────────────────────────────────────────

/** The lead's number from the lead row, re-validated now. Never from the URL or the request body. */
async function leadPhoneFor(q: CallQuery, ctx: HotLeadCallContext): Promise<string | null> {
  const lead = await crmDb.getLeadById(q.listId, q.leadId, { consistentRead: true });
  const callable = callableLeadPhone(lead?.phone, ctx.config);
  return 'phone' in callable ? callable.phone : null;
}

router.post('/gather', guarded(async (_req, res, q, body) => {
  const record = await loadMemberLegRecord(q, body);
  if (!record || record.state !== 'member_answered') return sendHangup(res);
  const ctx = await liveContext(q, record);
  if (!ctx) {
    await abortCall(q, record, ['member_answered']);
    return sendHangup(res);
  }

  // One decision per call, whatever the key: a replay or a later different digit cannot reverse it.
  const decision = { [decisionKey(record.memberCallSid, 'gather')]: 1 };
  const answered = (outcome: string): HotLeadCallPatch => ({ state: 'member_answered', outcome, lastSequence: decision });

  if (body.Digits !== '1') {
    await decide(q, ['member_answered'], answered('member_declined'), 'call.member_declined');
    return sendHangup(res);
  }

  const leadE164 = await leadPhoneFor(q, ctx);
  if (!leadE164 || !ctx.config.twilioNumber) {
    await decide(q, ['member_answered'], answered('lead_phone_invalid'), 'call.failed', { reason: 'lead_phone_invalid' });
    return sendXml(res, leadUnreachableTwiml());
  }

  // The call was approved for the phone that passed the gates. A repeat submission can overwrite lead.phone
  // afterwards, so the live number must still be that one (a record with no MAC cannot prove it and is refused).
  if (record.leadPhoneMac !== leadPhoneMacOf(ctx.orgId, leadE164)) {
    await decide(q, ['member_answered'], answered('lead_phone_changed'), 'call.failed', { reason: 'lead_phone_changed' });
    return sendXml(res, leadPhoneChangedTwiml());
  }

  // Built before the transition so that a builder that throws cannot leave the record 'bridging' with
  // the member hung up.
  const connect = connectTwiml({
    twilioNumber: ctx.config.twilioNumber,
    leadE164,
    dialUrl: buildVoiceWebhookUrl('dial', q),
    statusUrl: buildVoiceWebhookUrl('status', q, { leg: 'lead' }),
    screenUrl: buildVoiceWebhookUrl('screen', q),
  });
  // Only the winner dials the lead; a replayed "1" gets a hangup instead of a second bridge.
  if (!await decide(q, ['member_answered'], { state: 'bridging', lastSequence: decision })) return sendHangup(res);
  sendXml(res, connect);
}, twimlReplies));

// ── /screen and /screen-result: the lead must confirm before the two calls are bridged ──────────

// Both run on the lead's leg, after the lead answers the <Number> and before the parties are connected. The
// request parameters of that leg are not documented, so these endpoints are identified only by the signed
// query ids plus the record state, and the body CallSid is taken to be the lead leg's.

router.post('/screen', guarded(async (_req, res, q, body) => {
  const record = await loadRecord(q);
  const sid = sidOf(body, 'CallSid');
  // The member's own sid here would mean the request is not on the lead's leg: never adopt it as the lead's.
  if (!record?.memberCallSid || !sid || sid === record.memberCallSid || record.state !== 'bridging') return sendHangup(res);

  const store = getLeadCallStore();
  let current = record;
  if (!current.leadCallSid) {
    // First writer names the lead leg; a Twilio retry of the same request finds its own sid and is served again.
    await decide(q, ['bridging'], { state: 'bridging', leadCallSid: sid, lastSequence: { [LEAD_SID_ADOPTED]: 1 } });
    current = (await store.get(q.listId, q.leadId)) ?? record;
  }
  if (current.leadCallSid !== sid || current.state !== 'bridging') return sendHangup(res);

  const ctx = await liveContext(q, current);
  if (!ctx) {
    // Shares the dial marker, so /dial's own outcome cannot relabel an abort as a decline.
    await decide(q, ['bridging'], {
      state: 'bridging', outcome: 'aborted', lastSequence: { [decisionKey(record.memberCallSid, 'dial')]: 1 },
    }, 'call.failed', { reason: 'aborted' });
    return sendHangup(res);
  }
  sendXml(res, leadScreenTwiml({ announcedName: ctx.config.announcedName, resultUrl: buildVoiceWebhookUrl('screen-result', q) }));
}, twimlReplies));

router.post('/screen-result', guarded(async (_req, res, q, body) => {
  const record = await loadRecord(q);
  const sid = sidOf(body, 'CallSid');
  if (!record?.memberCallSid || !sid || sid !== record.leadCallSid) return sendHangup(res);

  const store = getLeadCallStore();
  const marker = decisionKey(sid, 'screen');
  const pressed = body.Digits === '1';
  // One decision per screening, whatever the key: a replay or a later different digit cannot reverse it.
  if (record.state === 'bridging') {
    if (pressed) {
      await decide(q, ['bridging'], { state: 'connected', lastSequence: { [marker]: 1 } }, 'call.connected');
    } else {
      await decide(q, ['bridging'], {
        state: 'bridging',
        outcome: 'lead_declined',
        // The dial marker too, so /dial's DialBridged=false result for this same decline writes nothing twice.
        lastSequence: { [marker]: 1, [decisionKey(record.memberCallSid, 'dial')]: 1 },
      }, 'call.lead_declined');
    }
  }
  const decided = await store.get(q.listId, q.leadId);
  const accepted = decided?.lastSequence?.[marker] !== undefined && decided.outcome !== 'lead_declined';
  // An empty response ends the screening leg normally, so Twilio bridges the calls.
  sendXml(res, accepted ? bridgeTwiml() : hangupTwiml());
}, twimlReplies));

// ── /dial: the <Dial> to the lead ended ─────────────────────────────────────

router.post('/dial', guarded(async (_req, res, q, body) => {
  const record = await loadMemberLegRecord(q, body);
  if (!record) return sendHangup(res);

  const memberSid = record.memberCallSid;
  const status = body.DialCallStatus ?? '';
  // DialCallSid is the lead leg; keep it only if nothing contradicts it.
  const dialSid = sidOf(body, 'DialCallSid');
  const leadCallSid = dialSid && dialSid !== memberSid && !record.leadCallSid ? dialSid : undefined;

  if (DIAL_ENDED_AFTER_ANSWER.has(status)) {
    // The lead answered, but "completed" alone does not say whether anyone talked: DialBridged does.
    if (body.DialBridged === 'true') {
      // Normally already connected by /screen-result; this covers it arriving late or never.
      await decide(q, ['bridging'], { state: 'connected', leadCallSid }, 'call.connected');
      return sendHangup(res);
    }
    if (body.DialBridged !== 'false' || record.state !== 'bridging') return sendHangup(res);
    // The lead hung up, pressed something else or said nothing at the screening prompt.
    await decide(q, ['bridging'], {
      state: 'bridging',
      outcome: 'lead_declined',
      leadCallSid,
      lastSequence: { [decisionKey(memberSid, 'dial')]: 1 },
    }, 'call.lead_declined');
    return sendXml(res, leadDeclinedTwiml());
  }
  if (status === 'canceled') {
    // The dial was cancelled while the lead was still ringing, which is the member hanging up: nobody was told the
    // lead did not answer, and we cannot say whether the lead picked up. The record finishes through the
    // normal leg metering as bridge_unconfirmed (call.completed only).
    await decide(q, ['bridging'], {
      state: 'bridging',
      outcome: 'bridge_unconfirmed',
      leadCallSid,
      lastSequence: { [decisionKey(memberSid, 'dial')]: 1 },
    });
    return sendHangup(res);
  }
  if (LEAD_NOT_REACHED.has(status)) {
    await decide(q, ['bridging'], {
      state: 'bridging',
      outcome: 'lead_no_answer',
      leadCallSid,
      lastSequence: { [decisionKey(memberSid, 'dial')]: 1 },
    }, 'call.lead_no_answer', { dialStatus: status });
    return sendXml(res, leadUnreachableTwiml());
  }
  sendHangup(res);
}, twimlReplies));

// ── /status: per-leg call progress (metering) ───────────────────────────────

/**
 * Lead leg progress: remember its sid. An answered lead leg is NOT a connection: the lead may still hang up at
 * the screening prompt, so connected comes from /screen-result or /dial.
 */
async function handleProgress(cb: LegCallback, record: HotLeadCallRecord): Promise<void> {
  const { q, callSid, sequence } = cb;
  if (q.leg !== 'lead' || (record.state !== 'bridging' && record.state !== 'connected')) return;
  await getLeadCallStore().transition(q.listId, q.leadId, [record.state], {
    state: record.state,
    leadCallSid: record.leadCallSid ? undefined : callSid,
    lastSequence: sequence === undefined ? undefined : { [callSid]: sequence },
  });
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
    // An absent, empty or blank field is NaN on purpose (Number('') would be 0): recordCallUsage warns instead of billing 0.
    durationSeconds: body.CallDuration?.trim() ? Number(body.CallDuration) : NaN,
  };

  const record = q.leg === 'member' ? await withMemberSid(q, loaded, callSid) : loaded;
  const memberSid = record.memberCallSid;
  if (!memberSid) return ack(res);
  if (q.leg === 'member') {
    if (callSid !== memberSid) return ack(res);
  } else if (body.ParentCallSid !== memberSid || callSid === memberSid || (record.leadCallSid && record.leadCallSid !== callSid)) {
    return ack(res);
  }

  if (!TERMINAL_CALL_STATUSES.has(callStatus)) {
    await handleProgress(cb, record);
    return ack(res);
  }
  // Nothing partial is left behind in either case, so the redelivery can still meter the leg.
  const metered = await meterLeg(cb);
  if (metered.status !== 'done') return serverError(res);
  if (metered.attemptEnded) {
    await nextAttemptOrFinish(q, metered.attemptEnded);
    return ack(res);
  }
  // Whichever leg is metered last finishes the call (also heals a crash between the two steps).
  await finishIfComplete(q);
  ack(res);
}, statusReplies));

export default router;
