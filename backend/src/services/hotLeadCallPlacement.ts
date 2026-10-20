import { redactPhone } from './whatsappService';
import type { HotLeadCallConfig, HotLeadCallMember } from './hotLeadCallConfig';
import { VoiceCallError, getVoiceProvider, scrubErrorText } from './voice/voiceProvider';
import { buildVoiceWebhookUrl } from './voice/voiceUrls';
import { claimMemberCooldown } from './voice/hotLeadCallLimits';
import { getLeadCallStore } from './voice/leadCallStore';
import type { HotLeadCallEventType, LeadCallStore } from './voice/leadCallStore.types';

const MEMBER_RING_TIMEOUT_SECONDS = 25;

export const errorText = (err: unknown): string => scrubErrorText(err instanceof Error ? err.message : 'unknown').slice(0, 200);

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

export interface PlacementInput {
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
  createRecord?: (member: HotLeadCallMember) => Promise<boolean>;
}

/** Closes a record that is waiting between attempts, because no further member can be rung. */
export async function closeBetweenAttempts(
  store: LeadCallStore, listId: string, leadId: string, outcome: string, rejected: boolean,
): Promise<void> {
  const patch = rejected ? { state: 'failed' as const, outcome } : { state: 'finished' as const, outcome };
  try {
    // A rejected attempt already put call.failed on the timeline; a clean end reports completion.
    if (await store.transition(listId, leadId, ['between_attempts'], patch) && !rejected) {
      await store.addEvent(listId, leadId, 'call.completed', { outcome });
    }
  } catch (err) {
    console.warn('[hotLeadCall] call record not closed', { listId, leadId, error: errorText(err) });
  }
}

/**
 * Rings the first candidate that can be: one pass over the members for the first attempt and for every next
 * one. Per member: claim the member's cooldown (in cooldown = next member), take the record (create for the
 * first attempt, otherwise the conditional between_attempts -> dialing move; the winner of that is the only
 * worker that may dial this attempt), place the call. A call Twilio definitely rejected ends only that attempt
 * and the pass goes on to the next member, up to maxAttemptsPerLead; an ambiguous failure stops everything
 * (the call may be live, and the webhooks adopt and meter it). At most one member call is in flight per lead.
 */
export async function placeMemberCall(input: PlacementInput): Promise<PlacementResult> {
  const { orgId, listId, leadId, jobKey, config, callerNumber } = input;
  const store = getLeadCallStore();
  const webhook = { listId, leadId, jobKey };
  // Built before any claim: a missing BACKEND_URL must fail the job without using a slot or a member's cooldown.
  const url = buildVoiceWebhookUrl('owner', webhook);
  const statusCallbackUrl = buildVoiceWebhookUrl('status', webhook);

  let pendingCreate = input.createRecord;
  let recordExists = !input.createRecord;
  let attemptNo = input.attemptNo;
  let rejected = false;

  // If a post-call transition fails the record stays 'dialing'; the first signed member callback adopts the CallSid.
  const settle = async (patch: Parameters<typeof store.transition>[3], event: HotLeadCallEventType, detail: Record<string, string | number>) => {
    try {
      if (!await store.transition(listId, leadId, ['dialing'], patch)) return false;
      await store.addEvent(listId, leadId, event, detail);
      return true;
    } catch (err) {
      console.warn('[hotLeadCall] call record not updated', { listId, leadId, error: errorText(err) });
      return false;
    }
  };

  for (const member of input.candidates) {
    if (attemptNo > config.maxAttemptsPerLead) break;
    const releaseCooldown = await claimMemberCooldown({ orgId, memberId: member.id, config });
    if (!releaseCooldown) continue;

    let owned: boolean;
    try {
      owned = pendingCreate
        ? await pendingCreate(member)
        // '' clears the previous attempt's call sid and outcome (an empty value means "none").
        : await store.transition(listId, leadId, ['between_attempts'], {
          state: 'dialing', attemptNo, memberId: member.id, triedMemberIds: [member.id], memberCallSid: '', outcome: '',
        });
    } catch (err) {
      await releaseCooldown();
      throw err;
    }
    if (!owned) {
      await releaseCooldown();
      return 'lost';
    }
    pendingCreate = undefined;
    recordExists = true;
    const detail = { attempt: attemptNo, memberId: member.id };

    let memberCallSid: string;
    try {
      ({ callSid: memberCallSid } = await getVoiceProvider().placeCall({
        to: member.phone, from: callerNumber, url, statusCallbackUrl, timeoutSeconds: MEMBER_RING_TIMEOUT_SECONDS,
      }));
    } catch (err) {
      if (err instanceof VoiceCallError && err.placed === 'no') {
        console.warn('[hotLeadCall] member call rejected', { listId, leadId, to: redactPhone(member.phone) });
        // This attempt is dead and nobody was rung: the pass moves on to the next member.
        if (!await settle({ state: 'between_attempts', outcome: 'place_rejected' }, 'call.failed', { reason: 'place_rejected', ...detail })) return 'stopped';
        rejected = true;
        attemptNo++;
        continue;
      }
      // The call may be live: stay non-terminal so the webhooks can still adopt and meter it. Never retried.
      console.warn('[hotLeadCall] member call placement unknown', { listId, leadId, to: redactPhone(member.phone) });
      await settle({ state: 'dialing', outcome: 'placement_unknown' }, 'call.failed', { reason: 'placement_unknown', ...detail });
      return 'stopped';
    }
    await settle({ state: 'member_ringing', memberCallSid }, 'call.initiated', detail);
    return 'ringing';
  }

  if (!recordExists) return 'none';
  await closeBetweenAttempts(store, listId, leadId, rejected ? 'place_rejected' : 'no_member_available', rejected);
  return 'closed';
}
