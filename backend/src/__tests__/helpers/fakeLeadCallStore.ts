import type { HotLeadCallEventType, HotLeadCallPatch, HotLeadCallRecord, HotLeadCallState, LeadCallStore, RetryRestart } from '../../services/voice/leadCallStore.types';

const TERMINAL: HotLeadCallState[] = ['finished', 'failed', 'skipped'];
const SCALAR_FIELDS = ['state', 'jobKey', 'startedAt', 'updatedAt', 'memberCallSid', 'leadCallSid', 'outcome', 'attemptNo', 'memberId', 'claimToken', 'deferral'] as const;

/**
 * In-memory LeadCallStore with the same conditional semantics as the DynamoDB one: create-if-absent,
 * a `from` list that names a terminal state is refused, a lastSequence entry must be strictly higher,
 * meteredLegs and triedMemberIds only append values not yet present, `clear` removes fields, and every check is part of the same atomic step.
 * Tests seed or inspect `record` and `events` directly and script failures with `transitionError`.
 */
export class FakeLeadCallStore implements LeadCallStore {
  record: HotLeadCallRecord | null = null;
  events: Array<{ type: HotLeadCallEventType; detail?: Record<string, unknown> }> = [];
  /** Number of transitions that were applied (refused ones are not counted). */
  transitions = 0;
  /** When set, every transition throws it, like a failing database. */
  transitionError: Error | null = null;

  async get(): Promise<HotLeadCallRecord | null> {
    return this.record ? structuredClone(this.record) : null;
  }

  async create(_listId: string, _leadId: string, record: HotLeadCallRecord): Promise<boolean> {
    if (this.record) return false;
    this.record = { meteredLegs: [], lastSequence: {}, ...structuredClone(record) };
    return true;
  }

  async transition(
    _listId: string,
    _leadId: string,
    from: HotLeadCallState[],
    patch: HotLeadCallPatch,
  ): Promise<boolean> {
    if (this.transitionError) throw this.transitionError;
    // The real update expression cannot touch one path twice.
    if ((patch.clear ?? []).some((f) => patch[f] !== undefined)) throw new Error(`${patch.clear} is both set and cleared`);
    const r = this.record;
    if (!r || from.length === 0 || from.some((s) => TERMINAL.includes(s)) || !from.includes(r.state)) return false;
    if (patch.ifAttemptNo !== undefined && r.attemptNo !== patch.ifAttemptNo) return false;
    const seq = patch.lastSequence ?? {};
    if (Object.entries(seq).some(([k, v]) => r.lastSequence?.[k] !== undefined && r.lastSequence[k] >= v)) return false;
    const legs = [...new Set(patch.meteredLegs ?? [])];
    if (legs.some((l) => r.meteredLegs?.includes(l))) return false;
    const tried = [...new Set(patch.triedMemberIds ?? [])];
    if (tried.some((id) => r.triedMemberIds?.includes(id))) return false;
    for (const field of SCALAR_FIELDS) {
      if (patch[field] !== undefined) (r as unknown as Record<string, unknown>)[field] = patch[field];
    }
    for (const field of patch.clear ?? []) delete r[field];
    r.lastSequence = { ...r.lastSequence, ...seq };
    r.meteredLegs = [...(r.meteredLegs ?? []), ...legs];
    r.triedMemberIds = [...(r.triedMemberIds ?? []), ...tried];
    this.transitions++;
    return true;
  }

  async claimRetry(_listId: string, _leadId: string, jobKey: string, token: string): Promise<boolean> {
    const r = this.record;
    if (!r || r.state !== 'finished' || r.jobKey !== jobKey || r.outcome !== 'lead_deferred' || r.retryClaimToken !== undefined) return false;
    r.retryClaimToken = token;
    return true;
  }

  async rescheduleRetry(_listId: string, _leadId: string, jobKey: string, deferral: { dueAt: string; firstDueAt?: string }): Promise<boolean> {
    const r = this.record;
    if (!r || r.state !== 'finished' || r.jobKey !== jobKey || r.outcome !== 'lead_deferred' || r.retryClaimToken !== undefined) return false;
    r.deferral = { dueAt: deferral.dueAt, count: 1, ...(deferral.firstDueAt ? { firstDueAt: deferral.firstDueAt } : {}) };
    return true;
  }

  async releaseRetryClaim(_listId: string, _leadId: string, token: string, deferral: { dueAt: string; firstDueAt: string }): Promise<boolean> {
    const r = this.record;
    if (!r || r.state !== 'finished' || r.outcome !== 'lead_deferred' || r.retryClaimToken !== token) return false;
    delete r.retryClaimToken;
    delete r.retryClaimedAt;
    r.deferral = { dueAt: deferral.dueAt, count: 1, firstDueAt: deferral.firstDueAt };
    return true;
  }

  async restartForRetry(_listId: string, _leadId: string, from: { jobKey: string; token: string }, fresh: RetryRestart): Promise<boolean> {
    const r = this.record;
    if (!r || r.state !== 'finished' || r.jobKey !== from.jobKey || r.retryClaimToken !== from.token) return false;
    for (const field of ['memberCallSid', 'leadCallSid', 'outcome'] as const) delete r[field];
    Object.assign(r, { ...fresh, state: 'dialing', attemptNo: 1, triedMemberIds: [fresh.memberId], meteredLegs: [], lastSequence: {} });
    return true;
  }

  async addEvent(_listId: string, _leadId: string, type: HotLeadCallEventType, detail?: Record<string, unknown>): Promise<void> {
    this.events.push({ type, detail });
  }

  eventTypes(): HotLeadCallEventType[] {
    return this.events.map((e) => e.type);
  }
}
