/**
 * Shared contract between the hot-lead call orchestrator (places the owner call) and the Twilio
 * voice webhooks (drive the call forward). Types only: the store implementation lives with the
 * webhooks, the orchestrator and tests use the interface.
 */

export type HotLeadCallState =
  | 'dialing' // claimed, owner call being created; no CallSid known yet
  | 'owner_ringing'
  | 'owner_answered' // owner picked up, prompt playing
  | 'bridging' // owner pressed 1, dialing the lead
  | 'connected' // lead answered, both legs bridged
  | 'finished' // terminal: call completed (any outcome recorded in `outcome`)
  | 'failed' // terminal: could not place or complete the call
  | 'skipped'; // terminal: a gate refused the call (no Twilio call was made)

export type HotLeadCallLeg = 'owner' | 'lead';

export interface HotLeadCallRecord {
  state: HotLeadCallState;
  /** Queue job key that created the call; webhook URLs carry it so stale callbacks can be ignored. */
  jobKey: string;
  startedAt: string;
  updatedAt: string;
  ownerCallSid?: string;
  leadCallSid?: string;
  /** Short machine reason for terminal states, e.g. 'owner_no_answer', 'owner_declined', 'lead_no_answer'. */
  outcome?: string;
  /** Legs already metered through recordCallUsage, so a replayed status callback cannot meter twice. */
  meteredLegs?: HotLeadCallLeg[];
  /** Highest Twilio SequenceNumber handled per CallSid, to ignore out-of-order status callbacks. */
  lastSequence?: Record<string, number>;
}

/** Engagement event types written to the lead timeline (via addLeadEngagement). */
export type HotLeadCallEventType =
  | 'call.initiated'
  | 'call.owner_answered'
  | 'call.owner_declined'
  | 'call.owner_no_answer'
  | 'call.connected'
  | 'call.lead_no_answer'
  | 'call.completed'
  | 'call.failed'
  | 'call.skipped';

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
    patch: Partial<HotLeadCallRecord> & { state: HotLeadCallState },
  ): Promise<boolean>;
  addEvent(
    listId: string,
    leadId: string,
    type: HotLeadCallEventType,
    detail?: Record<string, string | number | boolean>,
  ): Promise<void>;
}
