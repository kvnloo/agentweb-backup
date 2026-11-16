import { randomUUID } from 'crypto';
import { redactPhone } from './whatsappService';
import type { HotLeadCallConfig, HotLeadCallMember } from './hotLeadCallConfig';
import { VoiceCallError, getVoiceProvider } from './voice/voiceProvider';
import { errorText } from './hotLeadCallText';
import { buildVoiceWebhookUrl } from './voice/voiceUrls';
import { claimMemberCooldown } from './voice/hotLeadCallLimits';
import { getLeadCallStore } from './voice/leadCallStore';
import type { HotLeadCallEventType, HotLeadCallPatch, HotLeadCallRecord, LeadCallStore } from './voice/leadCallStore.types';

export const MEMBER_RING_TIMEOUT_SECONDS = 25;
// The re-read that decides whether a write that reported a problem still landed: a read that fails is tried again.
const CLAIM_READ_ATTEMPTS = 3;
// Tries at recording a rejected placement before the record is closed where it stands.
const SETTLE_ATTEMPTS = 3;

/** How a placement pass ended. */
export type PlacementResult =
  /** A member's phone is ringing (or a fast webhook already moved the record on). */
  | 'ringing'
  /** The record is left as it is: an ambiguous placement (a call may be live), or a record update that did not land. */
  | 'stopped'
  /** Another worker owns the record (or the first attempt's record already existed): nothing was dialed. */
  | 'lost'
  /** Calls were rejected or no member could be rung: the record has been closed. */
  | 'closed'
  /** Nothing happened and no record exists: every candidate was in cooldown. */
  | 'none';

interface PlacementInput {
  orgId: string;
  listId: string;
  leadId: string;
  jobKey: string;
  config: HotLeadCallConfig;
  callerNumber: string;
  /** Members to try, in priority order, already filtered for availability and for members tried before. */
  candidates: readonly HotLeadCallMember[];
  /** The attempt number the first member gets. */
  attemptNo: number;
  /**
   * Set for a lead's first attempt: creates the call record for the first member that is not in cooldown (false
   * when one already exists). Absent for a next attempt, whose record is in `between_attempts`.
   */
  createRecord?: (member: HotLeadCallMember, claimToken: string) => Promise<boolean>;
}

/**
 * How a record that is waiting between attempts is closed: 'completed' (finished, call.completed: nobody more
 * to ring), 'rejected' (failed; the rejected call already put call.failed on the timeline) or 'errored'
 * (failed, call.failed: the work that should have rung the next member broke).
 */
type Closing = 'completed' | 'rejected' | 'errored';

/**
 * Closes the record that is waiting between attempts after attempt `attemptNo`, because no further member can be rung. A failed write is tried
 * once more and then thrown, so the job fails (the queue records it) instead of leaving the record waiting while the
 * caller believes it was closed; the record stays between_attempts, where a redelivered callback can still resolve it.
 */
export async function closeBetweenAttempts(
  store: LeadCallStore,
  close: {
    listId: string;
    leadId: string;
    /** The attempt that ended; undefined closes whichever attempt the lead's record is waiting after. */
    attemptNo: number | undefined;
    outcome: string;
    closing: Closing;
  },
): Promise<void> {
  const { listId, leadId, attemptNo, outcome, closing } = close;
  // Only the record of the attempt that ended: a stale job cannot close a later attempt's waiting record.
  const patch = { state: closing === 'completed' ? 'finished' as const : 'failed' as const, outcome, ifAttemptNo: attemptNo };
  let moved: boolean;
  try {
    moved = await store.transition(listId, leadId, ['between_attempts'], patch);
  } catch {
    moved = await store.transition(listId, leadId, ['between_attempts'], patch);
  }
  if (!moved) return;
  if (closing === 'completed') await store.addEvent(listId, leadId, 'call.completed', { outcome });
  if (closing === 'errored') await store.addEvent(listId, leadId, 'call.failed', { reason: outcome });
}

/** What one member's turn came to. 'cooldown' and 'rejected' let the pass go on to the next member. */
type MemberTurn = PlacementResult | 'cooldown' | 'rejected';

interface PlacementContext {
  orgId: string;
  listId: string;
  leadId: string;
  config: HotLeadCallConfig;
  callerNumber: string;
  store: LeadCallStore;
  url: string;
  statusCallbackUrl: string;
}

/**
 * Moves a record that is 'dialing' on after the call was placed (or refused). If the move does not land the record
 * stays 'dialing' and the first signed member callback adopts the CallSid.
 */
async function settle(
  { store, listId, leadId }: PlacementContext, patch: HotLeadCallPatch, event: HotLeadCallEventType, detail: Record<string, string | number>,
): Promise<boolean> {
  try {
    if (!await store.transition(listId, leadId, ['dialing'], patch)) return false;
    await store.addEvent(listId, leadId, event, detail);
    return true;
  } catch (err) {
    console.warn('[hotLeadCall] call record not updated', { listId, leadId, error: errorText(err) });
    return false;
  }
}

/** Whether the record carries this token: the write that was meant to put it there landed, whatever it reported. */
export async function holdsClaim(store: LeadCallStore, listId: string, leadId: string, claimToken: string): Promise<boolean> {
  return (await ownRecord(store, listId, leadId, claimToken)) !== null;
}

/** The record when it carries this token, else null. A read that fails is tried again, a few times. */
async function ownRecord(store: LeadCallStore, listId: string, leadId: string, claimToken: string): Promise<HotLeadCallRecord | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      const record = await store.get(listId, leadId);
      return record?.claimToken === claimToken ? record : null;
    } catch (err) {
      if (attempt >= CLAIM_READ_ATTEMPTS) throw err;
    }
  }
}

/**
 * Records that Twilio definitely rejected this attempt's call (dialing -> between_attempts). A write that reported
 * a problem may still have landed, and one that did not land leaves `dialing` with no call and no callback ever
 * coming, so after each try the record is read back (it keeps this attempt's token) and the move is made again
 * while it is still `dialing`, a few times. True when the record has moved on. When it cannot be moved it is closed
 * as failed where it stands (no call exists, so nothing else will ever resolve it) and this returns false, ending
 * the pass. An unreadable record or one that is not ours is unknown: false, and nothing is closed.
 */
async function settleRejection(c: PlacementContext, claimToken: string, detail: Record<string, string | number>): Promise<boolean> {
  const patch = { state: 'between_attempts', outcome: 'place_rejected' } as const;
  const event = { reason: 'place_rejected', ...detail };
  for (let attempt = 1; attempt <= SETTLE_ATTEMPTS; attempt++) {
    if (await settle(c, patch, 'call.failed', event)) return true;
    // An unreadable record is treated as unknown.
    const own = await ownRecord(c.store, c.listId, c.leadId, claimToken).catch(() => null);
    if (!own) return false;
    if (own.state !== 'dialing') return true;
  }
  if (await c.store.transition(c.listId, c.leadId, ['dialing'], { state: 'failed', outcome: 'place_rejected' })) {
    await c.store.addEvent(c.listId, c.leadId, 'call.failed', event);
  }
  return false;
}

/**
 * One member's turn: claim their cooldown, take the record (`createRecord` for a lead's first attempt, otherwise
 * the conditional between_attempts -> dialing move; the winner of that is the only worker that may dial this
 * attempt), place the call.
 */
async function tryMember(
  c: PlacementContext, member: HotLeadCallMember, attemptNo: number, createRecord: PlacementInput['createRecord'],
): Promise<MemberTurn> {
  const { orgId, listId, leadId, config, store } = c;
  const releaseCooldown = await claimMemberCooldown({ orgId, memberId: member.id, config });
  if (!releaseCooldown) return 'cooldown';

  const claimToken = randomUUID();
  let owned = false;
  let failure: unknown;
  try {
    owned = createRecord
      ? await createRecord(member, claimToken)
      // The new attempt starts without the previous attempt's call sid and outcome.
      : await store.transition(listId, leadId, ['between_attempts'], {
        state: 'dialing', attemptNo, memberId: member.id, triedMemberIds: [member.id], claimToken, clear: ['memberCallSid', 'outcome'],
        // Only from the attempt just before this one: a stale job cannot take a record that has gone on or ended later.
        ifAttemptNo: attemptNo - 1,
      });
  } catch (err) {
    failure = err;
  }
  // A write can commit and still report an error (a timeout after the commit) or, when the SDK retried it after
  // losing the response, report that it lost (its own condition failed against its own first try). Either way the
  // record then says `dialing`, nobody is going to dial it and nothing else ever will. Our own token on it means the
  // step is ours, so go on; a competing winner can never carry our token.
  if (!owned && await holdsClaim(store, listId, leadId, claimToken).catch(() => false)) owned = true;
  if (!owned) {
    await releaseCooldown();
    if (failure) throw failure;
    return 'lost';
  }

  const detail = { attempt: attemptNo, memberId: member.id };
  let memberCallSid: string;
  try {
    ({ callSid: memberCallSid } = await getVoiceProvider().placeCall({
      to: member.phone, from: c.callerNumber, url: c.url, statusCallbackUrl: c.statusCallbackUrl, timeoutSeconds: MEMBER_RING_TIMEOUT_SECONDS,
    }));
  } catch (err) {
    if (err instanceof VoiceCallError && err.placed === 'no') {
      console.warn('[hotLeadCall] member call rejected', { listId, leadId, to: redactPhone(member.phone) });
      // This attempt is dead and nobody was rung.
      return await settleRejection(c, claimToken, detail) ? 'rejected' : 'stopped';
    }
    // The call may be live: stay non-terminal so the webhooks can still adopt and meter it. Never retried.
    console.warn('[hotLeadCall] member call placement unknown', { listId, leadId, to: redactPhone(member.phone) });
    await settle(c, { state: 'dialing', outcome: 'placement_unknown' }, 'call.failed', { reason: 'placement_unknown', ...detail });
    return 'stopped';
  }
  await settle(c, { state: 'member_ringing', memberCallSid }, 'call.initiated', detail);
  return 'ringing';
}

/**
 * Rings the first candidate that can be: one pass over the members for the first attempt and for every next
 * one. A member in cooldown is passed over. A call Twilio definitely rejected ends only that attempt and the
 * pass goes on to the next member, up to maxAttemptsPerLead; an ambiguous failure stops everything (the call
 * may be live, and the webhooks adopt and meter it). At most one member call is in flight per lead.
 */
export async function placeMemberCall(input: PlacementInput): Promise<PlacementResult> {
  const { orgId, listId, leadId, jobKey, config, callerNumber } = input;
  const webhook = { listId, leadId, jobKey };
  const context: PlacementContext = {
    orgId, listId, leadId, config, callerNumber, store: getLeadCallStore(),
    // Built before any claim: a missing BACKEND_URL must fail the job without using a slot or a member's cooldown.
    url: buildVoiceWebhookUrl('owner', webhook),
    statusCallbackUrl: buildVoiceWebhookUrl('status', webhook),
  };

  let pendingCreate = input.createRecord;
  let recordExists = !input.createRecord;
  let attemptNo = input.attemptNo;
  let rejected = false;

  try {
    for (const member of input.candidates) {
      if (attemptNo > config.maxAttemptsPerLead) break;
      const turn = await tryMember(context, member, attemptNo, pendingCreate);
      if (turn === 'cooldown') continue;
      if (turn !== 'rejected') return turn;
      pendingCreate = undefined;
      recordExists = true;
      rejected = true;
      attemptNo++;
    }
    if (!recordExists) return 'none';
    await closeBetweenAttempts(context.store, {
      listId, leadId, attemptNo: attemptNo - 1, outcome: rejected ? 'place_rejected' : 'no_member_available', closing: rejected ? 'rejected' : 'completed',
    });
    return 'closed';
  } catch (err) {
    // After a rejected call the record waits between attempts with no call in flight, so no callback will ever come
    // for it: whatever broke the pass, the record is closed here (a first attempt's job and a next attempt's alike).
    if (rejected) {
      await closeBetweenAttempts(context.store, { listId, leadId, attemptNo: attemptNo - 1, outcome: 'next_attempt_failed', closing: 'errored' })
        .catch((closeErr) => console.warn('[hotLeadCall] call record not closed', { listId, leadId, error: errorText(closeErr) }));
    }
    throw err;
  }
}
