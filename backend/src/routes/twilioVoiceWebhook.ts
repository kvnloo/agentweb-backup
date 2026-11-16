/**
 * Twilio voice webhooks for the hot-lead auto-call (ENG-2271). Mounted at /api/webhooks/twilio-voice
 * with no auth middleware: Twilio is the caller, and every request proves itself with X-Twilio-Signature.
 *
 * Call shape: Twilio rings a team member (placed by the orchestrator) -> /owner prompts "press 1" ->
 * /gather dials the lead with <Dial><Number url=/screen> -> the lead answers and /screen asks them to press 1
 * -> /screen-result (a digit of 1 lets Twilio bridge the two calls; 2 defers one retry, 3 stops the calls) -> /dial reports how the bridge ended
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
 * Inbound callbacks (a lead dialling the org's number back) are separate, stateless endpoints (/inbound,
 * /inbound-screen, /inbound-screen-result, /inbound-dial, /inbound-status) with their own guard: the same
 * credentials + signature steps, but the org comes from the dialled number or from the signed orgId in the query
 * instead of a lead record. See the "Inbound callbacks" section at the end of this file.
 *
 * Decisions that do not change `state` (member declined, lead did not answer) are made once through marker
 * entries in `lastSequence`: see HotLeadCallRecord.lastSequence.
 */

import { randomUUID } from 'crypto';
import express from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { crmDb, orgDb } from '../services/db';
import { getVoiceProvider } from '../services/voice/voiceProvider';
import { voiceWebhookBaseUrl, buildVoiceWebhookUrl, buildInboundWebhookUrl, isWebhookSafeId } from '../services/voice/voiceUrls';
import { isHotLeadCallEnabled } from '../services/voice/hotLeadCallMode';
import { resolveHotLeadCallContext, type HotLeadCallContext } from '../services/voice/hotLeadCallContext';
import { getLeadCallStore } from '../services/voice/leadCallStore';
import type { HotLeadCallEventType, HotLeadCallPatch, HotLeadCallRecord, HotLeadCallState } from '../services/voice/leadCallStore.types';
import {
  decisionKey, errorName, finishIfComplete, meterLeg, nextAttemptOrFinish, type CallQuery, type LegCallback,
} from '../services/voice/callFinalisation';
import {
  bridgeTwiml, connectTwiml, hangupTwiml, inboundMemberScreenTwiml, inboundNobodyTwiml, inboundRingTwiml, inboundUnavailableTwiml,
  isE164, leadDeclinedTwiml, leadDeferredMemberTwiml, leadDeferredTwiml, leadOptedOutMemberTwiml, leadOptedOutTwiml, leadOtherKeyTwiml, leadPhoneChangedTwiml, leadScreenTwiml, leadUnreachableTwiml, memberPromptTwiml,
} from '../services/voice/twiml';
import { recordCallUsage } from '../services/voice/voiceUsage';
import {
  isAcceptingMember, nextInboundMember, resolveInboundContext, resolveInboundContextForOrg, triedMembersOf, type InboundContext,
} from '../services/voice/inboundCallback';
import { inboundCallerE164, reserveInboundSlot } from '../services/voice/inboundLimits';
import { leadPhoneMacOf } from '../services/voice/leadPhoneMac';
import { holdsClaim } from '../services/hotLeadCallPlacement';
import { callableLeadPhone } from '../services/hotLeadCallConfig';
import { isInsideLeadCallWindow } from '../services/voice/leadLocalHours';
import { isLeadDoNotCall, markNumberDoNotCallWithRetry } from '../services/voice/hotLeadCallDnc';
import { retryDueAt, retrySweepEnabled } from '../services/voice/hotLeadCallRetry';

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
// The callee's leg never took the call (the lead on an outbound call; a member on an inbound callback).
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

/**
 * The shared first half of every guard: credentials loaded (else 503) -> signature over the URL rebuilt from
 * BACKEND_URL (else 401). Returns the verified form body, or null after answering the request itself.
 */
async function verifiedBody(req: Request, res: Response): Promise<FormParams | null> {
  const provider = getVoiceProvider();
  let url: string;
  try {
    await provider.ensureCredentials();
    url = `${voiceWebhookBaseUrl()}${req.originalUrl}`;
  } catch (err) {
    // Cannot verify right now, so nothing is processed. Only /status carries a retry override.
    if (Date.now() - cannotVerifyLoggedAt >= CANNOT_VERIFY_LOG_WINDOW_MS) {
      cannotVerifyLoggedAt = Date.now();
      console.error('[hotLeadCall] cannot verify callback:', errorName(err));
    }
    res.status(503).end();
    return null;
  }
  const body = paramsOf(req);
  const signature = req.header('X-Twilio-Signature');
  if (!body || !provider.validateSignature({ url, params: body, signature })) {
    res.status(401).end();
    return null;
  }
  return body;
}

function guarded(handler: Handler, replies: ErrorReplies) {
  return async (req: Request, res: Response): Promise<void> => {
    const body = await verifiedBody(req, res);
    if (!body) return;
    const q = parseQuery(req);
    if (!q) {
      replies.invalid(res);
      return;
    }
    try {
      await handler(req, res, q, body);
    } catch (err) {
      // Name only: an error message from a lower layer may echo request data.
      console.error('[hotLeadCall] handler failed:', errorName(err));
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

/** The lead row and its number, re-validated now. Never from the URL or the request body. */
async function leadPhoneFor(q: CallQuery, ctx: HotLeadCallContext): Promise<{ phone: string; lead: unknown } | null> {
  const lead = await crmDb.getLeadById(q.listId, q.leadId, { consistentRead: true });
  const callable = callableLeadPhone(lead?.phone, ctx.config);
  return 'phone' in callable ? { phone: callable.phone, lead } : null;
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

  const leadNow = await leadPhoneFor(q, ctx);
  if (!leadNow || !ctx.config.twilioNumber) {
    await decide(q, ['member_answered'], answered('lead_phone_invalid'), 'call.failed', { reason: 'lead_phone_invalid' });
    return sendXml(res, leadUnreachableTwiml());
  }

  const leadE164 = leadNow.phone;
  // The lead (or the same number on another lead of the org) may have pressed 3 since the gates ran. A store failure
  // throws: the lead is not dialled.
  if (await isLeadDoNotCall({ orgId: ctx.orgId, lead: leadNow.lead, phoneE164: leadE164 })) {
    await decide(q, ['member_answered'], answered('lead_do_not_call'), 'call.failed', { reason: 'lead_do_not_call' });
    return sendXml(res, leadUnreachableTwiml());
  }

  // The member may have taken a while to answer: the lead's local window can have closed since the gates ran.
  if (!isInsideLeadCallWindow(leadE164, new Date())) {
    await decide(q, ['member_answered'], answered('lead_outside_hours'), 'call.failed', { reason: 'lead_outside_hours' });
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
  const claimToken = randomUUID();
  let won = false;
  let failure: unknown;
  try {
    won = await decide(q, ['member_answered'], { state: 'bridging', lastSequence: decision, claimToken });
  } catch (err) {
    failure = err;
  }
  // The write may have committed and then reported an error, or reported that it lost (the SDK retried it after
  // losing the response). Our token on the record means we hold the one decision: dial the lead now, because
  // nothing else will (the member would be hung up on, the record left bridging with no lead leg). A write that did
  // not land leaves the record at member_answered, where the member leg's end hands over to the next member.
  if (!won && await holdsClaim(getLeadCallStore(), q.listId, q.leadId, claimToken).catch(() => false)) won = true;
  if (!won && failure) throw failure;
  if (!won) return sendHangup(res);
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
  // The prompt speaks the org's number: one that is missing or not E.164 cannot be read out, so the call is aborted like any other.
  if (!ctx || !isE164(ctx.config.twilioNumber)) {
    // Shares the dial marker, so /dial's own outcome cannot relabel an abort as a decline.
    await decide(q, ['bridging'], {
      state: 'bridging', outcome: 'aborted', lastSequence: { [decisionKey(record.memberCallSid, 'dial')]: 1 },
    }, 'call.failed', { reason: 'aborted' });
    return sendHangup(res);
  }
  sendXml(res, leadScreenTwiml({ announcedName: ctx.config.announcedName, callbackNumber: ctx.config.twilioNumber, resultUrl: buildVoiceWebhookUrl('screen-result', q),
    // Option 2 is offered only when the retry can really happen: the same eligibility /screen-result applies to a 2 (first call,
    // retries and kill switch on, live config, the approved phone, an open window within 36 hours). It is checked again at the 2.
    canDefer: await canOfferDeferral(q, current),
  }));
}, twimlReplies));

/**
 * The lead pressed 3: stop calling this person. Two records, each written on its own so that neither can stop the other
 * or the goodbye: the org's do-not-call marker for the number (what a new lead with the same number is checked against;
 * claimed up to three times in-process) and the lead's own do-not-contact status. This digit never connects. If the marker
 * cannot be written the stop is only as strong as the contact status on THIS lead: a new lead with the same number would
 * not be caught by the marker, so that case is logged at error level with the stable alarm text
 * `[hotLeadCall] do-not-call write failed <orgId>` (never a number) for a human to act on.
 *
 * The org id is not in the signed call state (the query carries listId, leadId, jobKey and leg; the record holds no org id and
 * the jobKey is a hash), so it comes from the list's owner through resolveHotLeadCallContext: without a live context, or when
 * the lead's phone is no longer the one approved (the record keeps only a one-way MAC), no marker can be written.
 */
async function recordLeadOptOut(q: CallQuery, record: HotLeadCallRecord, ctx: HotLeadCallContext | null): Promise<void> {
  let lead: Awaited<ReturnType<typeof crmDb.getLeadById>> | null = null;
  try {
    lead = await crmDb.getLeadById(q.listId, q.leadId, { consistentRead: true });
  } catch (err) {
    console.warn('[hotLeadCall] opt-out: lead not read', errorName(err));
  }
  const callable = ctx && lead ? callableLeadPhone(lead.phone, ctx.config) : null;
  // The marker names the number that was approved for this call, not whatever a later submission put on the lead.
  if (ctx && callable && 'phone' in callable && record.leadPhoneMac === leadPhoneMacOf(ctx.orgId, callable.phone)) {
    if (!await markNumberDoNotCallWithRetry(ctx.orgId, callable.phone)) console.error(`[hotLeadCall] do-not-call write failed ${ctx.orgId}`);
  } else if (!ctx) {
    console.error('[hotLeadCall] do-not-call write failed: no live org context for the list, so the org marker could not be keyed');
  } else {
    console.error(`[hotLeadCall] do-not-call write failed ${ctx.orgId}: the lead's current phone is unreadable or not the one approved for this call`);
  }
  try {
    // An existing do-not-contact (an admin's, a bounce's) keeps its reason; 'unsubscribed' (an email opt-out) becomes do-not-contact.
    if (lead && lead.contactStatus !== 'do-not-contact') {
      const now = new Date().toISOString();
      await crmDb.updateLead(q.listId, q.leadId, {
        contactStatus: 'do-not-contact',
        contactStatusReason: 'opted-out',
        contactStatusNote: 'Pressed 3 on a hot-lead call',
        contactStatusUpdatedAt: now,
        contactStatusUpdatedBy: 'system',
        // Same side effect as the CRM's own do-not-contact action: the lead also leaves group email.
        unsubscribedFromGroupEmail: true,
        unsubscribedFromGroupEmailAt: now,
      });
    }
  } catch (err) {
    console.warn('[hotLeadCall] opt-out: contact status not written', errorName(err));
  }
}

const LEAD_REFUSALS = new Set(['lead_declined', 'lead_opted_out', 'lead_deferred']);

/**
 * When the one retry for a lead who pressed 2 is due, or null when this 2 is an ordinary decline: the call is itself the
 * retry (the record keeps its deferral), retries or the kill switch are off, there is no live config, the lead's phone is no longer the one approved for this
 * call, or no minute within 36 hours is inside both the lead window and the org's calling hours.
 */
async function deferralDueAt(q: CallQuery, record: HotLeadCallRecord): Promise<Date | null> {
  // No promise without a retry: with retries switched off, or the kill switch off (the cron would never run it), a 2 is a decline.
  if (record.deferral || !retrySweepEnabled() || !await isHotLeadCallEnabled()) return null;
  const ctx = await resolveHotLeadCallContext(q.listId);
  const leadNow = ctx ? await leadPhoneFor(q, ctx) : null;
  if (!ctx || !leadNow || record.leadPhoneMac !== leadPhoneMacOf(ctx.orgId, leadNow.phone)) return null;
  return retryDueAt(leadNow.phone, ctx.config, new Date());
}

/**
 * Whether /screen speaks option 2. The check reads the lead and the org, and a failing read must never hang the lead up: it is logged
 * once (error name only, no ids of people, no numbers) and the lead hears the two-option prompt, which promises nothing.
 */
async function canOfferDeferral(q: CallQuery, record: HotLeadCallRecord): Promise<boolean> {
  try {
    return await deferralDueAt(q, record) !== null;
  } catch (err) {
    console.warn('[hotLeadCall] retry eligibility unavailable, option 2 not offered:', errorName(err));
    return false;
  }
}

router.post('/screen-result', guarded(async (_req, res, q, body) => {
  const record = await loadRecord(q);
  const sid = sidOf(body, 'CallSid');
  if (!record?.memberCallSid || !sid || sid !== record.leadCallSid) return sendHangup(res);

  const store = getLeadCallStore();
  const marker = decisionKey(sid, 'screen');
  const pressed = body.Digits === '1';
  // One decision per screening, whatever the key: a replay or a later different digit (a 1 after a 3) cannot reverse it.
  if (record.state === 'bridging') {
    if (pressed) {
      await decide(q, ['bridging'], { state: 'connected', lastSequence: { [marker]: 1 } }, 'call.connected');
    } else if (body.Digits === '3') {
      // The stop is written BEFORE the decision, so a decision that is seen is always backed by it. A replay finds the marker.
      // A 3 that follows a 2 on the same screening wins over the pending retry: the markers are raised (2 > 1), the deferral removed.
      const afterDeferral = record.outcome === 'lead_deferred';
      if (record.lastSequence?.[marker] === undefined || afterDeferral) await recordLeadOptOut(q, record, await resolveHotLeadCallContext(q.listId));
      const level = afterDeferral ? 2 : 1;
      await decide(q, ['bridging'], {
        state: 'bridging',
        outcome: 'lead_opted_out',
        lastSequence: { [marker]: level, [decisionKey(record.memberCallSid, 'dial')]: level },
        ...(afterDeferral ? { clear: ['deferral' as const] } : {}),
      }, 'call.lead_declined', { reason: 'opted_out' });
    } else if (body.Digits === '2') {
      // Not available now: one later call, once. An ordinary decline (nothing scheduled) when deferralDueAt says so.
      const due = await deferralDueAt(q, record);
      await decide(q, ['bridging'], {
        state: 'bridging',
        outcome: due ? 'lead_deferred' : 'lead_declined',
        // firstDueAt never changes: the retry must be placed within six hours of it or it is given up (retry_expired).
        ...(due ? { deferral: { dueAt: due.toISOString(), count: 1, firstDueAt: due.toISOString() } } : {}),
        lastSequence: { [marker]: 1, [decisionKey(record.memberCallSid, 'dial')]: 1 },
      }, 'call.lead_declined', { reason: due ? 'not_available_now' : 'not_available_no_retry' });
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
  const accepted = decided?.lastSequence?.[marker] !== undefined && !LEAD_REFUSALS.has(decided.outcome ?? '');
  if (decided?.outcome === 'lead_opted_out') {
    // The goodbye names the business and gives the org number (64.1200(b)(2)): without a live config there is nothing to say, so the leg just ends.
    const ctx = await resolveHotLeadCallContext(q.listId);
    return sendXml(res, ctx && isE164(ctx.config.twilioNumber) ? leadOptedOutTwiml(ctx.config.announcedName, ctx.config.twilioNumber) : hangupTwiml());
  }
  if (body.Digits === '2' && decided?.outcome === 'lead_deferred') {
    const ctx = await resolveHotLeadCallContext(q.listId);
    return sendXml(res, ctx && isE164(ctx.config.twilioNumber) ? leadDeferredTwiml(ctx.config.announcedName, ctx.config.twilioNumber) : hangupTwiml());
  }
  if (body.Digits !== undefined && body.Digits !== '1' && body.Digits !== '3' && decided?.outcome === 'lead_declined') {
    // Any other key declines; the lead may have cut the prompt short before the number, so it is said here.
    const ctx = await resolveHotLeadCallContext(q.listId);
    return sendXml(res, ctx && isE164(ctx.config.twilioNumber) ? leadOtherKeyTwiml(ctx.config.twilioNumber) : hangupTwiml());
  }
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
    // The lead pressed 3 or 2 (/screen-result wrote that, and the marker above makes this write a no-op): say so to the member.
    const decided = await getLeadCallStore().get(q.listId, q.leadId);
    const told = decided?.outcome === 'lead_opted_out' ? leadOptedOutMemberTwiml : decided?.outcome === 'lead_deferred' ? leadDeferredMemberTwiml : leadDeclinedTwiml;
    return sendXml(res, told());
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

// ── Inbound callbacks: a lead dials the org's number back ─────────────────────
//
// Stateless: no lead call record is created (LeadCallStore is keyed by lead, and an inbound caller is not one).
// The state is the signed query of each step URL: the org and the members already tried, so a Twilio retry of a
// step repeats the same decision and every chain ends: each step adds one member, and the org's
// maxAttemptsPerLead bounds the chain. Each step re-reads the live config, so switching the feature off, removing
// a member or ending the plan stops the next step. Fail closed: anything that is not clearly allowed ends in a
// spoken refusal and a hangup, never in a connection.
//
//   /inbound              the number was dialled (its Twilio voice URL): find the org, ring the first member
//   /inbound-screen       on the member's leg after they answer: "a lead is calling back ... Press 1."
//   /inbound-screen-result  a digit of 1 lets Twilio bridge; anything else hangs up the member's leg
//   /inbound-dial         the <Dial> ended: bridged = done; otherwise ring the next member, or tell the caller
//   /inbound-status       the member leg's final callback: the only metered leg (see below)
//
// Metering: only the member leg (an outbound call from our number) is metered, with the existing outbound rate and
// the same idempotency key shape. The caller's own inbound leg is NOT metered: the rate card has no inbound voice
// rate, and one is not invented here.

interface InboundQuery { orgId: string; tried: string[] }

function parseInboundQuery(req: Request): InboundQuery | null {
  if (Object.keys(req.query).some((k) => k !== 'orgId' && k !== 'tried')) return null;
  const { orgId } = req.query;
  const tried = triedMembersOf(req.query.tried);
  return typeof orgId === 'string' && isWebhookSafeId(orgId) && tried ? { orgId, tried } : null;
}

const inboundRefusal: ErrorReplies = { invalid: (res) => sendXml(res, inboundUnavailableTwiml()), failed: (res) => sendXml(res, inboundUnavailableTwiml()) };

/** Runs one verified inbound step; an unexpected failure is answered with `replies.failed` (the error name is logged, never its message). */
async function runInbound(res: Response, replies: ErrorReplies, step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (err) {
    console.error('[hotLeadCall] inbound handler failed:', errorName(err));
    if (!res.headersSent) replies.failed(res);
  }
}

/** A step that continues a callback: the signed query carries the org and the members tried. Every step is answered with TwiML. */
function guardedInbound(handler: (res: Response, body: FormParams, q: InboundQuery) => Promise<void>, replies: ErrorReplies = inboundRefusal) {
  return async (req: Request, res: Response): Promise<void> => {
    const body = await verifiedBody(req, res);
    if (!body) return;
    const q = parseInboundQuery(req);
    if (!q) return replies.invalid(res);
    await runInbound(res, replies, () => handler(res, body, q));
  };
}

/** The entry point is the number's voice URL: Twilio calls it as configured, with the caller's own request and no query. */
function guardedInboundEntry(handler: (res: Response, body: FormParams) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    const body = await verifiedBody(req, res);
    if (!body) return;
    // The entry has no query state, so a signed request that carries one is not the number's voice URL.
    if (Object.keys(req.query).length > 0) return inboundRefusal.invalid(res);
    await runInbound(res, inboundRefusal, () => handler(res, body));
  };
}

/**
 * Rings the next member, or tells the caller nobody can take the call. `tried` are the members already rung.
 * `admit` (the entry point only) runs once a member would really be rung; when it returns false it has already
 * answered the caller, and nobody is rung.
 */
async function ringNextOrApologise(
  res: Response, ctx: InboundContext, tried: readonly string[], admit?: () => Promise<boolean>,
): Promise<void> {
  const member = nextInboundMember(ctx.config, tried, new Date());
  if (!member || !ctx.config.twilioNumber) return sendXml(res, inboundNobodyTwiml());
  // `admit` runs only once a member would really be rung, so a call nobody can take never costs a slot.
  if (admit && !await admit()) return;
  const step = { orgId: ctx.orgId, tried: [...tried, member.id] };
  sendXml(res, inboundRingTwiml({
    memberE164: member.phone,
    callerId: ctx.config.twilioNumber,
    screenUrl: buildInboundWebhookUrl('inbound-screen', step),
    dialUrl: buildInboundWebhookUrl('inbound-dial', step),
    statusUrl: buildInboundWebhookUrl('inbound-status', step),
  }));
}

/**
 * Takes the call's slot against the inbound abuse limits (ENG-2784). When refused or the store fails, answers the
 * caller itself (the nobody copy / the unavailable copy: fail closed) and returns false. Only org, reason and the
 * outcome are logged, never the caller's number.
 */
async function admitInboundCall(res: Response, ctx: InboundContext, body: FormParams): Promise<boolean> {
  try {
    // A signed Twilio call always has a CallSid; without one the retry marker cannot work, so the call is not admitted.
    const callSid = sidOf(body, 'CallSid');
    if (!callSid) throw new Error('missing CallSid');
    const slot = await reserveInboundSlot({ orgId: ctx.orgId, callSid, callerE164: inboundCallerE164(body.From), config: ctx.config });
    if (slot.ok) return true;
    console.warn('[hotLeadCall] inbound capped', slot.reason, ctx.orgId);
    sendXml(res, inboundNobodyTwiml());
  } catch (err) {
    console.warn('[hotLeadCall] inbound limits unavailable', errorName(err));
    sendXml(res, inboundUnavailableTwiml());
  }
  return false;
}

router.post('/inbound', guardedInboundEntry(async (res, body) => {
  const ctx = await resolveInboundContext(body.To || body.Called);
  if (!ctx) return sendXml(res, inboundUnavailableTwiml());
  await ringNextOrApologise(res, ctx, [], () => admitInboundCall(res, ctx, body));
}));

router.post('/inbound-screen', guardedInbound(async (res, _body, q) => {
  const ctx = await resolveInboundContextForOrg(q.orgId);
  // The member being asked is the last one tried. Not accepting any more (removed, unverified) hangs up their leg, so the next one is tried.
  if (!ctx || !isAcceptingMember(ctx.config, q.tried[q.tried.length - 1])) return sendHangup(res);
  sendXml(res, inboundMemberScreenTwiml({
    announcedName: ctx.config.announcedName,
    resultUrl: buildInboundWebhookUrl('inbound-screen-result', q),
  }));
}, twimlReplies));

router.post('/inbound-screen-result', guardedInbound(async (res, body, q) => {
  if (body.Digits !== '1') return sendHangup(res);
  const ctx = await resolveInboundContextForOrg(q.orgId);
  if (!ctx || !isAcceptingMember(ctx.config, q.tried[q.tried.length - 1])) return sendHangup(res);
  // An empty response ends the member's screening leg normally, so Twilio bridges the two calls.
  sendXml(res, bridgeTwiml());
}, twimlReplies));

router.post('/inbound-dial', guardedInbound(async (res, body, q) => {
  const status = body.DialCallStatus ?? '';
  // Bridged: the conversation happened and is over. Cancelled: the caller hung up while it rang. Any other
  // answer without an explicit DialBridged=false cannot be told from a finished conversation, so nobody else is rung.
  const tryNext = LEAD_NOT_REACHED.has(status) || (DIAL_ENDED_AFTER_ANSWER.has(status) && body.DialBridged === 'false');
  if (!tryNext) return sendHangup(res);
  const ctx = await resolveInboundContextForOrg(q.orgId);
  if (!ctx) return sendXml(res, inboundUnavailableTwiml());
  await ringNextOrApologise(res, ctx, q.tried);
}));

// Deliberately not gated on the kill switch, config or plan: the leg already happened and must still be billed.
router.post('/inbound-status', guardedInbound(async (res, body, q) => {
  const callSid = sidOf(body, 'CallSid');
  // A member leg is always a child of the caller's call.
  if (!callSid || !sidOf(body, 'ParentCallSid') || !TERMINAL_CALL_STATUSES.has(body.CallStatus ?? '')) return ack(res);
  const org = await orgDb.getOrgById(q.orgId, undefined, true);
  if (!org?.ownerUserId) {
    console.error('[hotLeadCall] inbound member leg not metered: no owner to bill for org', q.orgId);
    return ack(res);
  }
  await recordCallUsage({
    userId: org.ownerUserId,
    callSid,
    leg: 'member',
    // Absent or blank is NaN on purpose: recordCallUsage warns instead of billing 0.
    durationSeconds: body.CallDuration?.trim() ? Number(body.CallDuration) : NaN,
  });
  ack(res);
}, statusReplies));

export default router;
