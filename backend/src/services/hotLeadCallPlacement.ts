import { randomUUID } from 'crypto';
import { redactPhone } from './whatsappService';
import type { HotLeadCallConfig, HotLeadCallMember } from './hotLeadCallConfig';
import { VoiceCallError, getVoiceProvider } from './voice/voiceProvider';
import { errorText } from './hotLeadCallText';
import { buildVoiceWebhookUrl } from './voice/voiceUrls';
import { claimMemberCooldown } from './voice/hotLeadCallLimits';
import { getLeadCallStore } from './voice/leadCallStore';
import type { HotLeadCallEventType, HotLeadCallPatch, LeadCallStore } from './voice/leadCallStore.types';

const MEMBER_RING_TIMEOUT_SECONDS = 25;

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
 * Closes a record that is waiting between attempts, because no further member can be rung. A failed write is tried
 * once more and then thrown, so the job fails (the queue records it) instead of leaving the record waiting while the
 * caller believes it was closed; the record stays between_attempts, where a redelivered callback can still resolve it.
 */
export async function closeBetweenAttempts(
  store: LeadCallStore, listId: string, leadId: string, outcome: string, closing: Closing,
): Promise<void> {
  const patch = closing === 'completed' ? { state: 'finished' as const, outcome } : { state: 'failed' as const, outcome };
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
  return (await store.get(listId, leadId))?.claimToken === claimToken;
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
  let owned: boolean;
  try {
    owned = createRecord
      ? await createRecord(member, claimToken)
      // The new attempt starts without the previous attempt's call sid and outcome.
      : await store.transition(listId, leadId, ['between_attempts'], {
        state: 'dialing', attemptNo, memberId: member.id, triedMemberIds: [member.id], claimToken, clear: ['memberCallSid', 'outcome'],
      });
  } catch (err) {
    // The write may have committed and then reported an error (a timeout): the record then says `dialing`, nobody
    // is going to dial it, and nothing else ever will. Our own token on it means the step is ours, so go on.
    if (await holdsClaim(store, listId, leadId, claimToken)) owned = true;
    else {
      await releaseCooldown();
      throw err;
    }
  }
  if (!owned) {
    await releaseCooldown();
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
      return await settle(c, { state: 'between_attempts', outcome: 'place_rejected' }, 'call.failed', { reason: 'place_rejected', ...detail })
        ? 'rejected'
        : 'stopped';
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
  await closeBetweenAttempts(context.store, listId, leadId, rejected ? 'place_rejected' : 'no_member_available', rejected ? 'rejected' : 'completed');
  return 'closed';
}
