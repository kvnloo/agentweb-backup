/**
 * Shared contract between the hot-lead call orchestrator (places the member call) and the Twilio
 * voice webhooks (drive the call forward). Types only: the implementation is in leadCallStore.ts;
 * the orchestrator, the webhooks and tests use this interface.
 */

export type HotLeadCallState =
  | 'dialing' // record created; the member call is being placed (or placement was ambiguous)
  | 'member_ringing'
  | 'member_answered' // member picked up, prompt playing
  | 'between_attempts' // a member leg ended without taking the lead; the next member has not been called yet
  | 'bridging' // member pressed 1, dialing the lead
  | 'connected' // lead answered, both legs bridged
  | 'finished' // terminal: call completed (any outcome recorded in `outcome`)
  | 'failed' // terminal: could not place or complete the call
  | 'skipped'; // terminal: a gate refused the call (no Twilio call was made)

/** Which side of the call a Twilio callback is for. */
export type HotLeadCallLeg = 'member' | 'lead';

/** A metered leg: 'member:<attemptNo>' (one per attempt) or 'lead'. */
export type MeteredLeg = 'lead' | `member:${number}`;

export interface HotLeadCallRecord {
  state: HotLeadCallState;
  /** Queue job key that created the call; webhook URLs carry it so stale callbacks can be ignored. */
  jobKey: string;
  startedAt: string;
  updatedAt: string;
  /** 1-based number of the member call this record is on. */
  attemptNo: number;
  /** The member being rung by the current attempt (HotLeadCallMember.id). */
  memberId: string;
  /** Every member already called for this lead, in call order; never shrinks. */
  triedMemberIds: string[];
  memberCallSid?: string;
  leadCallSid?: string;
  /**
   * Keyed HMAC of the lead's E.164 phone as it was when the call passed the gates (never the phone itself).
   * The webhooks refuse to dial or screen a lead whose live phone no longer matches it, so a repeat
   * submission that overwrites lead.phone cannot redirect an approved call to another number. A stored record
   * without it counts as a changed phone: the webhooks never dial or screen on a number they cannot compare.
   */
  leadPhoneMac: string;
  /**
   * Random id written by the writer that takes an exclusive step (creating the record, taking a next attempt, the
   * member's press of 1). A write that reported an error may still have committed; re-reading the record and
   * finding one's own token tells the writer it holds the step, so it can go on instead of leaving the record
   * stranded, and without taking the step a second time.
   */
  claimToken?: string;
  /** Short machine reason for terminal states, e.g. 'member_no_answer', 'member_declined', 'lead_no_answer', 'lead_declined'. */
  outcome?: string;
  /** Legs already metered through recordCallUsage, so a replayed status callback cannot meter twice. */
  meteredLegs?: MeteredLeg[];
  /**
   * Highest Twilio SequenceNumber handled per CallSid, to ignore out-of-order status callbacks. It also holds
   * the voice webhooks' first-writer-wins decision markers, which rely on the same strictly-higher condition
   * (a second write of the same key fails):
   * - `<memberCallSid>#gather`: the member's one decision at the Gather;
   * - `<memberCallSid>#dial`: the one lead-side result of the dial (no answer, declined, aborted);
   * - `<memberCallSid>#ended`: the member leg ended without taking the lead;
   * - `<leadCallSid>#screen`: the lead's one answer at the screening prompt;
   * - `lead#adopt`: the first writer that names the lead leg.
   */
  lastSequence?: Record<string, number>;
}

/** Engagement event types written to the lead timeline (via addLeadEngagement). */
export type HotLeadCallEventType =
  | 'call.initiated'
  | 'call.member_answered'
  | 'call.member_declined'
  | 'call.member_no_answer'
  | 'call.lead_declined'
  | 'call.connected'
  | 'call.lead_no_answer'
  | 'call.completed'
  | 'call.failed'
  | 'call.skipped';

/** Record fields a transition can remove (not just overwrite): the ones a next attempt starts without. */
type ClearableField = 'memberCallSid' | 'outcome';

/** What a transition changes. `clear` removes fields; a field cannot be both set and cleared in one patch. */
export type HotLeadCallPatch = Partial<HotLeadCallRecord> & {
  state: HotLeadCallState;
  clear?: ClearableField[];
  /** Applies only while the record is on this attempt, so a stale writer cannot move a record that has gone on. */
  ifAttemptNo?: number;
};

export interface LeadCallStore {
  get(listId: string, leadId: string): Promise<HotLeadCallRecord | null>;
  /** Creates the record. Returns false if one already exists (never overwrites). */
  create(listId: string, leadId: string, record: HotLeadCallRecord): Promise<boolean>;
  /**
   * Applies `patch` only if the current state is one of `from`. Returns false when the condition
   * fails (a duplicate or out-of-order callback), so callers can treat it as a no-op.
   */
  transition(
    listId: string,
    leadId: string,
    from: HotLeadCallState[],
    patch: HotLeadCallPatch,
  ): Promise<boolean>;
  addEvent(
    listId: string,
    leadId: string,
    type: HotLeadCallEventType,
    detail?: Record<string, string | number | boolean>,
  ): Promise<void>;
}
