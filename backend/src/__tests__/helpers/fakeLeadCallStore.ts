import type { HotLeadCallEventType, HotLeadCallRecord, HotLeadCallState, LeadCallStore } from '../../services/voice/leadCallStore.types';

const TERMINAL: HotLeadCallState[] = ['finished', 'failed', 'skipped'];
const SCALAR_FIELDS = ['state', 'jobKey', 'startedAt', 'updatedAt', 'memberCallSid', 'leadCallSid', 'outcome', 'attemptNo', 'memberId'] as const;

/**
 * In-memory LeadCallStore with the same conditional semantics as the DynamoDB one: create-if-absent,
 * a `from` list that names a terminal state is refused, a lastSequence entry must be strictly higher,
 * meteredLegs and triedMemberIds only append values not yet present, and every check is part of the same atomic step.
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
    this.record = { meteredLegs: [], triedMemberIds: [], lastSequence: {}, ...structuredClone(record) };
    return true;
  }

  async transition(
    _listId: string,
    _leadId: string,
    from: HotLeadCallState[],
    patch: Partial<HotLeadCallRecord> & { state: HotLeadCallState },
  ): Promise<boolean> {
    if (this.transitionError) throw this.transitionError;
    const r = this.record;
    if (!r || from.length === 0 || from.some((s) => TERMINAL.includes(s)) || !from.includes(r.state)) return false;
    const seq = patch.lastSequence ?? {};
    if (Object.entries(seq).some(([k, v]) => r.lastSequence?.[k] !== undefined && r.lastSequence[k] >= v)) return false;
    const legs = [...new Set(patch.meteredLegs ?? [])];
    if (legs.some((l) => r.meteredLegs?.includes(l))) return false;
    const tried = [...new Set(patch.triedMemberIds ?? [])];
    if (tried.some((id) => r.triedMemberIds?.includes(id))) return false;
    for (const field of SCALAR_FIELDS) {
      if (patch[field] !== undefined) (r as unknown as Record<string, unknown>)[field] = patch[field];
    }
    r.lastSequence = { ...r.lastSequence, ...seq };
    r.meteredLegs = [...(r.meteredLegs ?? []), ...legs];
    r.triedMemberIds = [...(r.triedMemberIds ?? []), ...tried];
    this.transitions++;
    return true;
  }

  async addEvent(_listId: string, _leadId: string, type: HotLeadCallEventType, detail?: Record<string, unknown>): Promise<void> {
    this.events.push({ type, detail });
  }

  eventTypes(): HotLeadCallEventType[] {
    return this.events.map((e) => e.type);
  }
}
