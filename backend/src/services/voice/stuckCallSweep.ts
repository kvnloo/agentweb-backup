import { crmDb, orgDb } from '../db';
import { HOT_LEAD_CALL_LIMITS } from '../hotLeadCallConfig';
import { closeBetweenAttempts, MEMBER_RING_TIMEOUT_SECONDS } from '../hotLeadCallPlacement';
import { errorName, finishIfComplete, finishWaitingAttempt, leadLegExpected, meteredLegOf, meterLeg, type CallQuery } from './callFinalisation';
import { hotLeadCallOrgListIds } from './hotLeadCallOrgLists';
import { getLeadCallStore } from './leadCallStore';
import type { HotLeadCallLeg, HotLeadCallRecord, HotLeadCallState } from './leadCallStore.types';
import { BRIDGED_CALL_TIME_LIMIT_SECONDS, GATHER_TIMEOUT_SECONDS, LEAD_DIAL_TIMEOUT_SECONDS } from './twiml';
import { VoiceCallError, getVoiceProvider, type FetchedCall } from './voiceProvider';

/**
 * Stuck-record sweep (ENG-2271): finds hot-lead call records that stayed live longer than a call can last and
 * settles them from what Twilio itself says. It stands in for the final status callback that never arrived
 * (Twilio outage, 5xx beyond the retries, a crash mid-call): it fetches the call, meters each ended leg through
 * the same `meterLeg` the webhook uses (so a leg is billed once, whoever gets there first) and applies the same
 * finishing rule. It is read-only towards Twilio, never places a call and never asks for another member: a lead is
 * called at most once, however its record ends.
 *
 * A record is only ever closed when every leg it dialed is accounted for. Anything else is left exactly as it is
 * and reported for a human: a call Twilio says is still live, a call sid the record never learned, a duration
 * Twilio did not give, a Twilio error.
 */

const TAG = '[hotLeadCall]';

/** `HOT_LEAD_CALL_STUCK_SWEEP`: `off` disables the sweep, `close` lets it write, anything else (or unset) only reports. */
export type StuckSweepMode = 'off' | 'report' | 'close';

export function stuckSweepMode(): StuckSweepMode {
  const raw = process.env.HOT_LEAD_CALL_STUCK_SWEEP?.trim().toLowerCase();
  if (raw === 'close') return 'close';
  return raw === 'off' || raw === '0' || raw === 'false' ? 'off' : 'report';
}

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
/**
 * Added to every state's longest healthy dwell: Twilio's callback retries, the queue's reclaim of a dead worker
 * (5 minutes stale, polled every 30 seconds) and clock skew.
 */
const GRACE_MS = 10 * MINUTE_MS;
/** The longest a bridged call can run: the Dial's own limit, plus the lead's ring and the two keypress prompts before it. */
const BRIDGED_CALL_MS = (BRIDGED_CALL_TIME_LIMIT_SECONDS + LEAD_DIAL_TIMEOUT_SECONDS + 2 * GATHER_TIMEOUT_SECONDS) * SECOND_MS;

type SweepableState = Exclude<HotLeadCallState, 'finished' | 'failed' | 'skipped'>;
/**
 * How long after its last write a record may sit in each state before it counts as stuck. Every write refreshes
 * `updatedAt`, so this is the longest a healthy record waits for its NEXT write:
 * - dialing: one placeCall request (no sid yet);
 * - member_ringing: the member's ring (25 s), then /owner moves it on;
 * - member_answered: the keypress prompt (8 s), then /gather or the member's hangup moves it on;
 * - bridging, connected: the bridged call, whichever of /screen-result and /dial last wrote (bridging can outlast
 *   the conversation when /screen-result never arrived);
 * - between_attempts: no call is live; the next-attempt job or the queue poller moves it on, and a further
 *   attempt is refused once the lead is older than maxAgeMinutes (at most 60) from startedAt.
 */
export const STUCK_AFTER_MS: Record<SweepableState, number> = {
  dialing: GRACE_MS,
  member_ringing: MEMBER_RING_TIMEOUT_SECONDS * SECOND_MS + GRACE_MS,
  member_answered: GATHER_TIMEOUT_SECONDS * SECOND_MS + GRACE_MS,
  bridging: BRIDGED_CALL_MS + GRACE_MS,
  connected: BRIDGED_CALL_MS + GRACE_MS,
  between_attempts: HOT_LEAD_CALL_LIMITS.maxAgeMinutes.max * MINUTE_MS + GRACE_MS,
};
const SWEEPABLE_STATES = Object.keys(STUCK_AFTER_MS) as SweepableState[];
const isSweepable = (state: HotLeadCallState): state is SweepableState => state in STUCK_AFTER_MS;

/** Hard bounds of one run (see "Stuck records" in docs/integrations/hot-lead-call.md). */
const MAX_LEADS_READ_PER_LIST = 500;
const MAX_LEADS_READ_PER_RUN = 10_000;
/** Records one run may write to (would close, in report mode). Records left for a human or failing do not use it up, so they cannot starve the rest. */
const MAX_WRITES_PER_RUN = 50;
/** Every record handled costs up to two Twilio reads, so those are bounded too. */
const MAX_RECORDS_HANDLED_PER_RUN = 200;

const SYSTEM_KEY = 'hot_lead_call';

interface LegToSettle {
  leg: HotLeadCallLeg;
  callSid: string;
}

export type StuckDecision =
  /** Young enough to be live, or not live at all. */
  | { action: 'leave' }
  /** Waiting between attempts with no job left to move it on: no call is in flight. */
  | { action: 'close_stranded' }
  /** Every dialed leg is metered already; only the finish was lost. */
  | { action: 'finish' }
  /** Ask Twilio about these legs, meter the ones that ended, then finish. */
  | { action: 'reconcile'; legs: LegToSettle[] }
  /** Cannot be settled from what is recorded: reported, never acted on. */
  | { action: 'needs_human'; reason: string };

/** Pure: what to do with a record at `nowMs`. No I/O, so the whole table is testable with a fake clock. */
export function decideStuck(record: HotLeadCallRecord, nowMs: number): StuckDecision {
  // An unreadable updatedAt makes the age NaN, which is not "old": such a record is left alone.
  if (!isSweepable(record.state) || !(nowMs - Date.parse(record.updatedAt) >= STUCK_AFTER_MS[record.state])) return { action: 'leave' };
  if (record.state === 'between_attempts') return { action: 'close_stranded' };

  const metered = record.meteredLegs ?? [];
  // The lead leg first: the member leg is the one that can end the attempt, so it is metered last.
  const legs: LegToSettle[] = [];
  if (leadLegExpected(record) && !metered.includes('lead')) {
    if (!record.leadCallSid) return { action: 'needs_human', reason: 'the lead call has no sid: a leg may exist that was never recorded' };
    legs.push({ leg: 'lead', callSid: record.leadCallSid });
  }
  if (!metered.includes(meteredLegOf('member', record))) {
    if (!record.memberCallSid) return { action: 'needs_human', reason: 'the member call has no sid: a call may exist that was never recorded' };
    legs.push({ leg: 'member', callSid: record.memberCallSid });
  }
  return legs.length ? { action: 'reconcile', legs } : { action: 'finish' };
}

// Twilio leaves `duration` empty for these, so an absent one is a leg that never connected: nothing to bill.
const NEVER_CONNECTED = new Set(['busy', 'failed', 'no-answer', 'canceled']);
const ENDED = new Set(['completed', ...NEVER_CONNECTED]);

/** What Twilio said about a leg once every leg was fetched. */
type Reading =
  | { kind: 'ended'; leg: HotLeadCallLeg; callSid: string; durationSeconds: number }
  | { kind: 'live' }
  | { kind: 'no_duration' };

function readCall({ leg, callSid }: LegToSettle, call: FetchedCall): Reading {
  if (!ENDED.has(call.status)) return { kind: 'live' };
  if (call.durationSeconds !== undefined) return { kind: 'ended', leg, callSid, durationSeconds: call.durationSeconds };
  return NEVER_CONNECTED.has(call.status) ? { kind: 'ended', leg, callSid, durationSeconds: 0 } : { kind: 'no_duration' };
}

export interface StuckSweepSummary {
  mode: StuckSweepMode;
  orgs: number;
  lists: number;
  /** Leads read to find the records (the read cost of the run). */
  leadsRead: number;
  /** A read bound stopped a list or the run (it fires on any large list: not a signal by itself), or a write/handled cap left records for the next run. */
  truncated: boolean;
  /** Records the read found: live and older than the youngest state threshold (decideStuck then applies each state's own). */
  found: number;
  /** In report mode: records the sweep would have closed. */
  wouldClose: number;
  closed: number;
  /** Twilio says a call of the record is still live: left alone. */
  stillLive: number;
  /** Left alone and logged for a human. */
  needsHuman: number;
  /** Found by the coarse read but not stuck for its state (or gone) when re-read. */
  notStuck: number;
  /** Written to, but the record did not end up closed: another writer moved it meanwhile. */
  moved: number;
  /** Twilio or the store failed: nothing (more) was changed. */
  failed: number;
}

interface Candidate {
  orgId: string;
  listId: string;
  leadId: string;
}

const logRecord = (c: Candidate, state: string, what: string) =>
  console.warn(`${TAG} stuck call record: org ${c.orgId} list ${c.listId} lead ${c.leadId} state ${state}: ${what}`);

type Settled = keyof Pick<StuckSweepSummary, 'wouldClose' | 'closed' | 'stillLive' | 'needsHuman' | 'notStuck' | 'moved'>;

/** Whether `fresh` is still the call `decided` was decided on: same call, attempt, state and call sids. */
const sameCall = (decided: HotLeadCallRecord, fresh: HotLeadCallRecord | null): boolean =>
  !!fresh && fresh.jobKey === decided.jobKey && fresh.attemptNo === decided.attemptNo && fresh.state === decided.state
  && fresh.memberCallSid === decided.memberCallSid && fresh.leadCallSid === decided.leadCallSid;

/** Twilio's answer for one leg; a call Twilio has no record of (404) is for a human, any other failure is thrown. */
async function fetchLeg(leg: LegToSettle): Promise<FetchedCall | 'not_found'> {
  try {
    return await getVoiceProvider().fetchCall(leg.callSid);
  } catch (err) {
    if (err instanceof VoiceCallError && err.httpStatus === 404) return 'not_found';
    throw err;
  }
}

/** Settles one candidate and returns how it ended. Throws when Twilio or the store fails. */
async function handle(c: Candidate, mode: StuckSweepMode, nowMs: number): Promise<Settled> {
  const store = getLeadCallStore();
  // The discovery read is eventually consistent: decide on a consistent one.
  const record = await store.get(c.listId, c.leadId);
  if (!record) return 'notStuck';
  const decision = decideStuck(record, nowMs);
  if (decision.action === 'leave') return 'notStuck';
  const q: CallQuery = { listId: c.listId, leadId: c.leadId, jobKey: record.jobKey, leg: 'member' };

  if (decision.action === 'needs_human') {
    logRecord(c, record.state, `needs a human: ${decision.reason}`);
    return 'needsHuman';
  }

  const ended: Array<Extract<Reading, { kind: 'ended' }>> = [];
  if (decision.action === 'reconcile') {
    // Read every leg before writing any, so a Twilio failure leaves the record untouched.
    for (const leg of decision.legs) {
      const call = await fetchLeg(leg);
      if (call === 'not_found') {
        logRecord(c, record.state, `needs a human: Twilio has no record of the ${leg.leg} call`);
        return 'needsHuman';
      }
      const reading = readCall(leg, call);
      if (reading.kind === 'live') {
        logRecord(c, record.state, `Twilio says the ${leg.leg} call is still live: left alone`);
        return 'stillLive';
      }
      if (reading.kind === 'no_duration') {
        logRecord(c, record.state, `needs a human: Twilio gave no duration for the ended ${leg.leg} call, so it cannot be billed`);
        return 'needsHuman';
      }
      ended.push(reading);
    }
  }
  logRecord(c, record.state, `${mode === 'close' ? 'closing' : 'would close'} (${decision.action})`);
  if (mode !== 'close') return 'wouldClose';

  // Twilio was asked a while ago: a late genuine callback may have moved the record on (even to the next attempt).
  // Write only while it is still the call that was decided on; meterLeg checks the sid again at each write.
  if (!sameCall(record, await store.get(c.listId, c.leadId))) return 'moved';

  if (decision.action === 'close_stranded') {
    // The same close the next-attempt job makes when it breaks before ringing anyone.
    await closeBetweenAttempts(store, { listId: c.listId, leadId: c.leadId, attemptNo: record.attemptNo, outcome: 'next_attempt_failed', closing: 'errored' });
  } else {
    let attemptEnded: string | undefined;
    for (const leg of ended) {
      const metered = await meterLeg({ q: { ...q, leg: leg.leg }, callSid: leg.callSid, sequence: undefined, durationSeconds: leg.durationSeconds, expectSid: leg.callSid });
      if (metered.status !== 'done') throw new Error(`metering the ${leg.leg} leg gave ${metered.status}`);
      attemptEnded ??= metered.attemptEnded;
    }
    // A member leg that ended an attempt left the record waiting for the next member: nobody is asked for one.
    if (attemptEnded) await finishWaitingAttempt(q, record.attemptNo, attemptEnded);
    else await finishIfComplete(q);
  }
  const after = await store.get(c.listId, c.leadId);
  return after?.state === 'finished' || after?.state === 'failed' ? 'closed' : 'moved';
}

/** Records older than their state allows, from the orgs that have a hot-lead config (a released number keeps it): org -> members -> their lists -> newest leads. */
async function findCandidates(nowMs: number, summary: StuckSweepSummary): Promise<Candidate[]> {
  const found: Candidate[] = [];
  // The DB filter uses the youngest threshold (one query per list); decideStuck applies the exact one per state.
  const updatedBefore = new Date(nowMs - Math.min(...Object.values(STUCK_AFTER_MS))).toISOString();
  for (const orgId of await orgDb.listHotLeadCallOrgIds()) {
    summary.orgs++;
    try {
      for (const listId of await hotLeadCallOrgListIds(orgId)) {
        const budget = Math.min(MAX_LEADS_READ_PER_LIST, MAX_LEADS_READ_PER_RUN - summary.leadsRead);
        if (budget <= 0) { summary.truncated = true; break; }
        summary.lists++;
        const result = await crmDb.findLeadsBySystemRecord(listId, SYSTEM_KEY, { states: SWEEPABLE_STATES, updatedBefore, maxRead: budget });
        summary.leadsRead += result.read;
        summary.truncated ||= result.truncated;
        found.push(...result.leadIds.map((leadId) => ({ orgId, listId, leadId })));
      }
    } catch (err) {
      summary.failed++;
      console.error(`${TAG} stuck call sweep could not read org ${orgId}:`, errorName(err));
    }
  }
  return found;
}

/**
 * Settles the stuck records of every org that has a hot-lead config. Reads are bounded (see the constants); one record's
 * or org's failure never stops the rest; a second run, or an overlapping one, finds the work done or loses the
 * conditional write. Not gated on `hot_lead_call_mode`: a stuck record needs cleaning whether or not calling is on,
 * and nothing here can dial.
 */
export async function runStuckCallSweep(now: Date = new Date()): Promise<StuckSweepSummary> {
  const summary: StuckSweepSummary = {
    mode: stuckSweepMode(), orgs: 0, lists: 0, leadsRead: 0, truncated: false,
    found: 0, wouldClose: 0, closed: 0, stillLive: 0, needsHuman: 0, notStuck: 0, moved: 0, failed: 0,
  };
  if (summary.mode === 'off') return summary;

  const candidates = await findCandidates(now.getTime(), summary).catch((err) => {
    summary.failed++;
    console.error(`${TAG} stuck call sweep could not list the orgs:`, errorName(err));
    return [];
  });
  summary.found = candidates.length;
  let handled = 0;
  for (const c of candidates) {
    if (summary.wouldClose + summary.closed >= MAX_WRITES_PER_RUN || handled >= MAX_RECORDS_HANDLED_PER_RUN) {
      summary.truncated = true;
      break;
    }
    handled++;
    try {
      summary[await handle(c, summary.mode, now.getTime())]++;
    } catch (err) {
      summary.failed++;
      console.error(`${TAG} stuck call record not settled: org ${c.orgId} list ${c.listId} lead ${c.leadId}:`, errorName(err));
    }
  }
  return summary;
}
