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
 * arrives the record stays non-terminal: records stuck in bridging/connected/between_attempts need an ops
 * cleanup (no cron is added here).
 *
 * The URL paths keep their original names: /owner now serves the prompt to the team member being rung.
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
import type { HotLeadCallEventType, HotLeadCallLeg, HotLeadCallRecord, HotLeadCallState, MeteredLeg } from '../services/voice/leadCallStore.types';
import { recordCallUsage } from '../services/voice/voiceUsage';
import {
  bridgeTwiml, connectTwiml, hangupTwiml, leadDeclinedTwiml, leadPhoneChangedTwiml, leadScreenTwiml, leadUnreachableTwiml, memberPromptTwiml,
} from '../services/voice/twiml';
import { leadPhoneMacOf } from '../services/voice/leadPhoneMac';
import { callableLeadPhone } from '../services/hotLeadCallConfig';
import { requestNextHotLeadCallAttempt } from '../services/hotLeadCallAttempts';

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

const LIVE_STATES: HotLeadCallState[] = ['dialing', 'member_ringing', 'member_answered', 'bridging', 'connected'];
const TERMINAL_CALL_STATUSES = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled']);
const LEAD_NOT_REACHED = new Set(['no-answer', 'busy', 'failed']);
const DIAL_ENDED_AFTER_ANSWER = new Set(['completed', 'answered']);
// Outcomes that belong to a member's own attempt. They are stale once a later attempt has the member on the line.
const MEMBER_OUTCOMES = new Set(['member_declined', 'member_no_answer']);
const MAX_TRANSITION_ATTEMPTS = 3;

// Marker entries in `lastSequence` that make a decision first-writer-wins: see HotLeadCallRecord.lastSequence.
const decisionKey = (callSid: string, step: 'gather' | 'dial' | 'screen'): string => `${callSid}#${step}`;
// Written together with leadCallSid by /screen: the first writer wins the right to name the lead leg.
const LEAD_SID_ADOPTED = 'lead#adopt';
/** `meteredLegs` entry of a leg: member legs are numbered by attempt ('member:1'), the lead leg is 'lead'. */
const meteredLegOf = (leg: HotLeadCallLeg, record: HotLeadCallRecord): MeteredLeg =>
  leg === 'lead' ? 'lead' : `member:${record.attemptNo ?? 1}`;
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
  // A next attempt that is still being placed has no sid either ('' after the reset), but a late callback of an
  // earlier attempt's call must not be taken for it: every earlier member leg left a marker behind.
  if (alreadyHandled(record, callSid)) return record;
  const store = getLeadCallStore();
  // Adoption moves the record out of 'dialing', so the orchestrator's later settle loses and only this path
  // writes call.initiated.
  if (await store.transition(q.listId, q.leadId, ['dialing'], { state: 'member_ringing', memberCallSid: callSid })) {
    await store.addEvent(q.listId, q.leadId, 'call.initiated');
  }
  return (await store.get(q.listId, q.leadId)) ?? record; // a lost race still shows whichever sid won
}

/** Whether a call this record already dealt with (metered, or a decision taken on it) carries this sid. */
const alreadyHandled = (record: HotLeadCallRecord, callSid: string): boolean =>
  Object.keys(record.lastSequence ?? {}).some((key) => key.split('#')[0] === callSid);

const sidOf = (body: FormParams, field: string): string | undefined => (CALL_SID_SHAPE.test(body[field] ?? '') ? body[field] : undefined);

/** User to bill for metering. Not tied to the config being enabled: a call placed earlier must still be billed. */
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
  const store = getLeadCallStore();
  // Only /gather's decision marker applies here: from /owner the call has not reached the gather step yet.
  const decision = record.state === 'member_answered' && record.memberCallSid ? { [decisionKey(record.memberCallSid, 'gather')]: 1 } : undefined;
  if (await store.transition(q.listId, q.leadId, from, { state: 'member_answered', outcome: 'aborted', lastSequence: decision })) {
    await store.addEvent(q.listId, q.leadId, 'call.failed', { reason: 'aborted' });
  }
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
  const loaded = await loadRecord(q);
  const ctx = await liveContext(q, loaded);
  const record = loaded && (await withMemberSid(q, loaded, sidOf(body, 'CallSid')));
  // A missing record is deliberately NOT adopted (created here): the orchestrator creates the record
  // before it dials, so no record means this callback is not for a call we placed, and a call without
  // a record could never be metered.
  if (!record || !record.memberCallSid || body.CallSid !== record.memberCallSid) return sendHangup(res);

  const awaitingAnswer = record.state === 'member_ringing' || record.state === 'dialing';
  if (!ctx) {
    if (awaitingAnswer) await abortCall(q, record, ['member_ringing', 'dialing']);
    return sendHangup(res);
  }
  const store = getLeadCallStore();
  if (awaitingAnswer) {
    // Won exactly once; the event is written only by the winner.
    if (await store.transition(q.listId, q.leadId, ['member_ringing', 'dialing'], { state: 'member_answered' })) {
      await store.addEvent(q.listId, q.leadId, 'call.member_answered');
    }
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
  const record = await loadRecord(q);
  const ctx = await liveContext(q, record);
  if (!record?.memberCallSid || body.CallSid !== record.memberCallSid || record.state !== 'member_answered') return sendHangup(res);
  if (!ctx) {
    await abortCall(q, record, ['member_answered']);
    return sendHangup(res);
  }

  const store = getLeadCallStore();
  // One decision per call, whatever the key: a replay or a later different digit cannot reverse it.
  const decision = { [decisionKey(record.memberCallSid, 'gather')]: 1 };

  if (body.Digits !== '1') {
    if (await store.transition(q.listId, q.leadId, ['member_answered'], { state: 'member_answered', outcome: 'member_declined', lastSequence: decision })) {
      await store.addEvent(q.listId, q.leadId, 'call.member_declined');
    }
    return sendHangup(res);
  }

  const leadE164 = await leadPhoneFor(q, ctx);
  if (!leadE164 || !ctx.config.twilioNumber) {
    if (await store.transition(q.listId, q.leadId, ['member_answered'], { state: 'member_answered', outcome: 'lead_phone_invalid', lastSequence: decision })) {
      await store.addEvent(q.listId, q.leadId, 'call.failed', { reason: 'lead_phone_invalid' });
    }
    return sendXml(res, leadUnreachableTwiml());
  }

  // The call was approved for the phone that passed the gates. A repeat submission can overwrite lead.phone
  // afterwards, so the live number must still be that one.
  if (record.leadPhoneMac && record.leadPhoneMac !== leadPhoneMacOf(ctx.orgId, leadE164)) {
    if (await store.transition(q.listId, q.leadId, ['member_answered'], { state: 'member_answered', outcome: 'lead_phone_changed', lastSequence: decision })) {
      await store.addEvent(q.listId, q.leadId, 'call.failed', { reason: 'lead_phone_changed' });
    }
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
  if (!(await store.transition(q.listId, q.leadId, ['member_answered'], { state: 'bridging', lastSequence: decision }))) return sendHangup(res);
  if (!record.leadPhoneMac) console.warn('[twilio-voice] call record has no leadPhoneMac (created before the check existed): lead phone not compared');
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
    await store.transition(q.listId, q.leadId, ['bridging'], { state: 'bridging', leadCallSid: sid, lastSequence: { [LEAD_SID_ADOPTED]: 1 } });
    current = (await store.get(q.listId, q.leadId)) ?? record;
  }
  if (current.leadCallSid !== sid || current.state !== 'bridging') return sendHangup(res);

  const ctx = await liveContext(q, current);
  if (!ctx) {
    // Shares the dial marker, so /dial's own outcome cannot relabel an abort as a decline.
    if (await store.transition(q.listId, q.leadId, ['bridging'], {
      state: 'bridging', outcome: 'aborted', lastSequence: { [decisionKey(record.memberCallSid, 'dial')]: 1 },
    })) {
      await store.addEvent(q.listId, q.leadId, 'call.failed', { reason: 'aborted' });
    }
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
    const won = pressed
      ? await store.transition(q.listId, q.leadId, ['bridging'], { state: 'connected', lastSequence: { [marker]: 1 } })
      : await store.transition(q.listId, q.leadId, ['bridging'], {
        state: 'bridging',
        outcome: 'lead_declined',
        // The dial marker too, so /dial's DialBridged=false result for this same decline writes nothing twice.
        lastSequence: { [marker]: 1, [decisionKey(record.memberCallSid, 'dial')]: 1 },
      });
    if (won) await store.addEvent(q.listId, q.leadId, pressed ? 'call.connected' : 'call.lead_declined');
  }
  const decided = await store.get(q.listId, q.leadId);
  const accepted = decided?.lastSequence?.[marker] !== undefined && decided.outcome !== 'lead_declined';
  // An empty response ends the screening leg normally, so Twilio bridges the calls.
  sendXml(res, accepted ? bridgeTwiml() : hangupTwiml());
}, twimlReplies));

// ── /dial: the <Dial> to the lead ended ─────────────────────────────────────

router.post('/dial', guarded(async (_req, res, q, body) => {
  const record = await loadRecord(q);
  if (!record?.memberCallSid || body.CallSid !== record.memberCallSid) return sendHangup(res);

  const store = getLeadCallStore();
  const memberSid = record.memberCallSid;
  const status = body.DialCallStatus ?? '';
  // DialCallSid is the lead leg; keep it only if nothing contradicts it.
  const dialSid = sidOf(body, 'DialCallSid');
  const leadCallSid = dialSid && dialSid !== memberSid && !record.leadCallSid ? dialSid : undefined;

  if (DIAL_ENDED_AFTER_ANSWER.has(status)) {
    // The lead answered, but "completed" alone does not say whether anyone talked: DialBridged does.
    if (body.DialBridged === 'true') {
      // Normally already connected by /screen-result; this covers it arriving late or never.
      if (await store.transition(q.listId, q.leadId, ['bridging'], { state: 'connected', leadCallSid })) {
        await store.addEvent(q.listId, q.leadId, 'call.connected');
      }
      return sendHangup(res);
    }
    if (body.DialBridged !== 'false' || record.state !== 'bridging') return sendHangup(res);
    // The lead hung up, pressed something else or said nothing at the screening prompt.
    const first = await store.transition(q.listId, q.leadId, ['bridging'], {
      state: 'bridging',
      outcome: 'lead_declined',
      leadCallSid,
      lastSequence: { [decisionKey(memberSid, 'dial')]: 1 },
    });
    if (first) await store.addEvent(q.listId, q.leadId, 'call.lead_declined');
    return sendXml(res, leadDeclinedTwiml());
  }
  if (status === 'canceled') {
    // The dial was cancelled while the lead was still ringing, which is the member hanging up: nobody was told the
    // lead did not answer, and we cannot say whether the lead picked up. The record finishes through the
    // normal leg metering as bridge_unconfirmed (call.completed only).
    await store.transition(q.listId, q.leadId, ['bridging'], {
      state: 'bridging',
      outcome: 'bridge_unconfirmed',
      leadCallSid,
      lastSequence: { [decisionKey(memberSid, 'dial')]: 1 },
    });
    return sendHangup(res);
  }
  if (LEAD_NOT_REACHED.has(status)) {
    const first = await store.transition(q.listId, q.leadId, ['bridging'], {
      state: 'bridging',
      outcome: 'lead_no_answer',
      leadCallSid,
      lastSequence: { [decisionKey(memberSid, 'dial')]: 1 },
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
  return metered.includes(meteredLegOf('member', record)) && (!leadLegExpected(record) || metered.includes('lead'));
}

async function finishIfComplete(q: CallQuery): Promise<void> {
  const store = getLeadCallStore();
  const record = await store.get(q.listId, q.leadId);
  if (!record || record.jobKey !== q.jobKey || !LIVE_STATES.includes(record.state) || !everyDialedLegMetered(record)) return;
  // Still bridging with no /dial result: we cannot say whether the lead picked up.
  const outcome = callOutcome(record) ?? (record.state === 'bridging' ? 'bridge_unconfirmed' : 'completed');
  if (await store.transition(q.listId, q.leadId, LIVE_STATES, { state: 'finished', outcome })) {
    await store.addEvent(q.listId, q.leadId, 'call.completed', { outcome });
  }
}

/**
 * The orchestrator marks an ambiguous placement with outcome 'placement_unknown' while the record stays
 * 'dialing': that is information, not a decision, so it must not suppress the real member outcome.
 */
const decidedOutcome = (record: HotLeadCallRecord): string | undefined =>
  // A next attempt clears the previous outcome by storing '' (the store cannot remove a field): '' means none.
  !record.outcome || record.outcome === 'placement_unknown' ? undefined : record.outcome;

/**
 * The outcome of the call as a whole. In bridging/connected a member outcome can only be left over from an
 * earlier attempt (the member took this one), so it is not the call's outcome.
 */
function callOutcome(record: HotLeadCallRecord): string | undefined {
  const outcome = decidedOutcome(record);
  const tookTheLead = record.state === 'bridging' || record.state === 'connected';
  return outcome && tookTheLead && MEMBER_OUTCOMES.has(outcome) ? undefined : outcome;
}

/**
 * How a member attempt ended when the member never took the lead, so that the next member can be tried: its
 * outcome, and the timeline event unless /gather already wrote it. Undefined when the member took the lead,
 * or when the call ended for a reason that must not move on to another member (aborted, lead phone changed or
 * invalid). `record.outcome` may be left over from an earlier attempt, so the state and the decision marker
 * of THIS attempt decide, not a stale outcome.
 */
function memberAttemptEnd(current: HotLeadCallRecord): { outcome: string; event?: HotLeadCallEventType } | undefined {
  const decided = decidedOutcome(current);
  if (decided && !MEMBER_OUTCOMES.has(decided)) return undefined;
  if (current.state === 'dialing' || current.state === 'member_ringing') return { outcome: 'member_no_answer', event: 'call.member_no_answer' };
  if (current.state !== 'member_answered') return undefined;
  // Pressed something other than 1 (event already written at /gather), or hung up on the prompt (the Gather
  // timeout falls through without posting to /gather).
  const decidedAtGather = current.memberCallSid && current.lastSequence?.[decisionKey(current.memberCallSid, 'gather')] !== undefined;
  return { outcome: 'member_declined', event: decidedAtGather ? undefined : 'call.member_declined' };
}

interface LegCallback {
  q: CallQuery;
  callSid: string;
  sequence: number | undefined;
  durationSeconds: number;
}

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

interface Metered {
  status: 'done' | 'no-owner-to-bill' | 'gave-up';
  /** Set when this caller metered a member leg that ended without the member taking the lead: the attempt's outcome. */
  attemptEnded?: string;
}

/**
 * Terminal status for one leg: record it as metered in ONE transition and bill only if this caller
 * won it. A member leg that ends without the member taking the lead moves the record to between_attempts in
 * that same transition. Returns 'no-owner-to-bill' when nothing could be written because nobody can be billed, and
 * 'gave-up' when every attempt lost its transition (the caller answers 5xx so the retry override redelivers).
 */
async function meterLeg(cb: LegCallback): Promise<Metered> {
  const { q, callSid, sequence } = cb;
  const store = getLeadCallStore();
  let billedUserId: string | null | undefined;
  for (let attempt = 0; attempt < MAX_TRANSITION_ATTEMPTS; attempt++) {
    const current = await store.get(q.listId, q.leadId);
    if (!current || current.jobKey !== q.jobKey || !LIVE_STATES.includes(current.state)) return { status: 'done' };
    const meteredLeg = meteredLegOf(q.leg, current);
    if ((current.meteredLegs ?? []).includes(meteredLeg)) return { status: 'done' };
    if (sequence !== undefined && (current.lastSequence?.[callSid] ?? -1) >= sequence) return { status: 'done' };

    if (billedUserId === undefined) billedUserId = await meteringUserId(q.listId, await resolveHotLeadCallContext(q.listId));
    if (!billedUserId) {
      console.error('[twilio-voice] no owner to bill for list', q.listId);
      return { status: 'no-owner-to-bill' };
    }

    const ended = q.leg === 'member' ? memberAttemptEnd(current) : undefined;
    const marks: Record<string, number> = {
      ...(sequence === undefined ? {} : { [callSid]: sequence }),
      // Tells a late callback of this call, once the next attempt is being placed, that its sid is not the next
      // attempt's (see withMemberSid).
      ...(ended ? { [`${callSid}#ended`]: 1 } : {}),
    };
    const won = await store.transition(q.listId, q.leadId, [current.state], {
      state: ended ? 'between_attempts' : current.state,
      meteredLegs: [meteredLeg],
      leadCallSid: q.leg === 'lead' && !current.leadCallSid ? callSid : undefined,
      outcome: ended?.outcome,
      lastSequence: Object.keys(marks).length ? marks : undefined,
    });
    if (!won) continue; // state moved under us (or a replay): look again

    if (ended?.event) await store.addEvent(q.listId, q.leadId, ended.event);
    try {
      await recordCallUsage({ userId: billedUserId, callSid, leg: q.leg, durationSeconds: cb.durationSeconds });
    } catch (err) {
      console.error('[twilio-voice] metering failed:', errorName(err));
    }
    return { status: 'done', attemptEnded: ended?.outcome };
  }
  console.error('[twilio-voice] metering gave up after retries:', q.leg);
  return { status: 'gave-up' };
}

/**
 * The attempt just ended (its leg is metered, the record is between_attempts): ask for the next member, and
 * finish the record when there is none. A first attempt keeps its own outcome (nobody else was ever
 * available); after a later attempt the outcome is no_member_available. If the seam throws nothing is known
 * to have been queued, so the record finishes: a call is never placed on a guess.
 */
async function nextAttemptOrFinish(q: CallQuery, attemptOutcome: string): Promise<void> {
  const store = getLeadCallStore();
  const record = await store.get(q.listId, q.leadId);
  if (!record || record.jobKey !== q.jobKey || record.state !== 'between_attempts') return;
  let enqueued = false;
  try {
    enqueued = (await requestNextHotLeadCallAttempt({ listId: q.listId, leadId: q.leadId, record })).enqueued;
  } catch (err) {
    console.error('[twilio-voice] next attempt request failed:', errorName(err));
  }
  if (enqueued) return;
  const outcome = (record.attemptNo ?? 1) > 1 ? 'no_member_available' : attemptOutcome;
  if (await store.transition(q.listId, q.leadId, ['between_attempts'], { state: 'finished', outcome })) {
    await store.addEvent(q.listId, q.leadId, 'call.completed', { outcome });
  }
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
