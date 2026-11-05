/**
 * Metering and finalisation of a hot-lead call, driven by the voice webhooks' per-leg status callbacks:
 * a finished leg is recorded as metered and billed exactly once, a member attempt that did not take the lead
 * hands over to the next member (or closes the record), and the last leg to be metered finishes the call.
 * The record is only ever moved through LeadCallStore.transition, so every step is a conditional write and a
 * replayed callback finds its work already done.
 */

import { crmDb } from '../db';
import { requestNextHotLeadCallAttempt } from '../hotLeadCallAttempts';
import { resolveHotLeadCallContext, type HotLeadCallContext } from './hotLeadCallContext';
import { getLeadCallStore } from './leadCallStore';
import type { HotLeadCallEventType, HotLeadCallLeg, HotLeadCallRecord, HotLeadCallState, MeteredLeg } from './leadCallStore.types';
import { recordCallUsage } from './voiceUsage';

/** What the signed query of a callback identifies: the lead, the call (job) and which leg it is for. */
export interface CallQuery {
  listId: string;
  leadId: string;
  jobKey: string;
  leg: HotLeadCallLeg;
}

export interface LegCallback {
  q: CallQuery;
  callSid: string;
  sequence: number | undefined;
  durationSeconds: number;
  /**
   * Meter only while the record's call sid for this leg is still this one: a caller that decided on an earlier read
   * (the stuck-record sweep) must not meter a record that has since moved on to another attempt. The webhooks pass
   * nothing, so their behaviour is unchanged.
   */
  expectSid?: string;
}

/** States in which a leg can still be metered and the call finished: everything before a terminal state. */
const LIVE_STATES: HotLeadCallState[] = ['dialing', 'member_ringing', 'member_answered', 'bridging', 'connected'];
// Outcomes that belong to a member's own attempt. They are stale once a later attempt has the member on the line.
const MEMBER_OUTCOMES = new Set(['member_declined', 'member_no_answer']);
const MAX_TRANSITION_ATTEMPTS = 3;

// Marker entries in `lastSequence` that make a decision first-writer-wins: see HotLeadCallRecord.lastSequence.
export const decisionKey = (callSid: string, step: 'gather' | 'dial' | 'screen'): string => `${callSid}#${step}`;
/** `meteredLegs` entry of a leg: member legs are numbered by attempt ('member:1'), the lead leg is 'lead'. */
export const meteredLegOf = (leg: HotLeadCallLeg, record: HotLeadCallRecord): MeteredLeg =>
  leg === 'lead' ? 'lead' : `member:${record.attemptNo}`;
export const errorName = (err: unknown): string => (err instanceof Error ? err.name : 'unknown error');

/** User to bill for metering. Not tied to the config being enabled: a call placed earlier must still be billed. */
async function meteringUserId(listId: string, ctx: HotLeadCallContext | null): Promise<string | null> {
  if (ctx) return ctx.ownerUserId;
  const list = await crmDb.getLeadListById(listId, { consistentRead: true });
  return list && list.listId === listId && typeof list.userId === 'string' && list.userId ? list.userId : null;
}

/**
 * Whether a lead leg was (or may be) dialed and so must be metered before the record can finish. After
 * /dial reported no-answer with no DialCallSid, no lead call was ever created, so none is awaited.
 */
export function leadLegExpected(record: HotLeadCallRecord): boolean {
  if (record.state !== 'bridging' && record.state !== 'connected') return false;
  return !(record.leadCallSid === undefined && record.outcome === 'lead_no_answer');
}

function everyDialedLegMetered(record: HotLeadCallRecord): boolean {
  const metered = record.meteredLegs ?? [];
  return metered.includes(meteredLegOf('member', record)) && (!leadLegExpected(record) || metered.includes('lead'));
}

export async function finishIfComplete(q: CallQuery): Promise<void> {
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

const endedKey = (callSid: string): string => `${callSid}#ended`;

/** Whether this member leg was metered and ended its attempt, and nothing has moved the record on since. */
const waitingAfterThisLeg = (record: HotLeadCallRecord, callSid: string): boolean =>
  record.state === 'between_attempts' && record.lastSequence?.[endedKey(callSid)] !== undefined && !!record.outcome;

export type Metered =
  /**
   * The leg is metered (by this caller or earlier). `attemptEnded` is the attempt's outcome when a member leg ended
   * without the member taking the lead and the record still waits for the next member: set for the caller that
   * metered it and for a redelivery that finds the hand-over undone.
   */
  | { status: 'done'; attemptEnded?: string }
  /** Nothing could be written because nobody can be billed. */
  | { status: 'no-owner-to-bill' }
  /** Every attempt lost its transition: the caller answers 5xx so the retry override redelivers. */
  | { status: 'gave-up' };

/**
 * Terminal status for one leg: record it as metered in ONE transition and bill only if this caller
 * won it. A member leg that ends without the member taking the lead moves the record to between_attempts in
 * that same transition.
 */
export async function meterLeg(cb: LegCallback): Promise<Metered> {
  const { q, callSid, sequence } = cb;
  const store = getLeadCallStore();
  let billedUserId: string | null | undefined;
  for (let attempt = 0; attempt < MAX_TRANSITION_ATTEMPTS; attempt++) {
    const current = await store.get(q.listId, q.leadId);
    if (!current || current.jobKey !== q.jobKey) return { status: 'done' };
    if (cb.expectSid !== undefined && cb.expectSid !== (q.leg === 'member' ? current.memberCallSid : current.leadCallSid)) return { status: 'done' };
    // A redelivery of the callback that already metered this member leg and ended the attempt. Nothing is left to
    // write, but the hand-over after it may never have happened (a store error between the two, or a next-attempt
    // request that failed): the record is still waiting between attempts, so ask again. Asking is idempotent.
    if (q.leg === 'member' && waitingAfterThisLeg(current, callSid)) return { status: 'done', attemptEnded: current.outcome };
    if (!LIVE_STATES.includes(current.state)) return { status: 'done' };
    const meteredLeg = meteredLegOf(q.leg, current);
    if ((current.meteredLegs ?? []).includes(meteredLeg)) return { status: 'done' };
    if (sequence !== undefined && (current.lastSequence?.[callSid] ?? -1) >= sequence) return { status: 'done' };

    if (billedUserId === undefined) billedUserId = await meteringUserId(q.listId, await resolveHotLeadCallContext(q.listId));
    if (!billedUserId) {
      console.error('[hotLeadCall] no owner to bill for list', q.listId);
      return { status: 'no-owner-to-bill' };
    }

    const ended = q.leg === 'member' ? memberAttemptEnd(current) : undefined;
    const marks: Record<string, number> = {
      ...(sequence === undefined ? {} : { [callSid]: sequence }),
      // Tells a late callback of this call, once the next attempt is being placed, that its sid is not the next
      // attempt's (see withMemberSid in the webhook route).
      ...(ended ? { [endedKey(callSid)]: 1 } : {}),
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
      console.error('[hotLeadCall] metering failed:', errorName(err));
    }
    return { status: 'done', attemptEnded: ended?.outcome };
  }
  console.error('[hotLeadCall] metering gave up after retries:', q.leg);
  return { status: 'gave-up' };
}

/**
 * The attempt just ended (its leg is metered, the record is between_attempts): ask for the next member, and
 * finish the record when there is none. A first attempt keeps its own outcome (nobody else was ever
 * available); after a later attempt the outcome is no_member_available. If the seam throws nothing is known
 * to have been queued, so the record finishes: a call is never placed on a guess.
 */
export async function nextAttemptOrFinish(q: CallQuery, attemptOutcome: string): Promise<void> {
  const store = getLeadCallStore();
  const record = await store.get(q.listId, q.leadId);
  if (!record || record.jobKey !== q.jobKey || record.state !== 'between_attempts') return;
  try {
    const decision = await requestNextHotLeadCallAttempt({ listId: q.listId, leadId: q.leadId, record });
    if (decision.enqueued) return;
    console.info('[hotLeadCall] no further attempt:', decision.reason);
  } catch (err) {
    console.error('[hotLeadCall] next attempt request failed:', errorName(err));
  }
  await finishWaitingAttempt(q, record.attemptNo, attemptOutcome);
}

/**
 * Closes the record that waits after attempt `attemptNo` because nobody else will be rung. The finish is guarded with
 * the attempt, so a record that has gone on to a later one is left alone. The caller has already chosen not to ask
 * for another member (the stuck-record sweep never does).
 */
export async function finishWaitingAttempt(q: CallQuery, attemptNo: number, attemptOutcome: string): Promise<void> {
  const store = getLeadCallStore();
  const outcome = attemptNo > 1 ? 'no_member_available' : attemptOutcome;
  if (await store.transition(q.listId, q.leadId, ['between_attempts'], { state: 'finished', outcome, ifAttemptNo: attemptNo })) {
    await store.addEvent(q.listId, q.leadId, 'call.completed', { outcome });
  }
}
