import { crmDb, ENGAGED_EVENT_KEYWORDS } from '../db';
import { redactPhones } from './redactText';
import { errorCode } from './setupWrites';
import type {
  HotLeadCallEventType,
  HotLeadCallPatch,
  HotLeadCallRecord,
  HotLeadCallState,
  LeadCallStore,
  MeteredLeg,
  RetryRestart,
} from './leadCallStore.types';

/** Key under `lead.system` that holds the record. No table or index: the call state rides on the lead row. */
const SYSTEM_KEY = 'hot_lead_call';

const MAX_DETAIL_VALUE_LENGTH = 200;

const TERMINAL_STATES: HotLeadCallState[] = ['finished', 'failed', 'skipped'];

// db.ts raises `isEngaged` (the lead counts as engaged/hot in lists and filters) when an engagement's
// eventType or serialised eventData contains one of ENGAGED_EVENT_KEYWORDS. A call event must never do
// that, so detail entries containing them are dropped.
function mentionsEngagement(text: string): boolean {
  const lower = text.toLowerCase();
  return ENGAGED_EVENT_KEYWORDS.some((k) => lower.includes(k));
}

/** Detail values are scalars only; phone-like text is redacted and engagement-raising words are dropped. */
function sanitizeDetail(detail: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  const clean: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(detail)) {
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') continue;
    if (redactPhones(key) !== key) continue;
    const value = typeof raw === 'string' ? redactPhones(raw).slice(0, MAX_DETAIL_VALUE_LENGTH) : raw;
    // A bare number can itself be a phone number (e.g. 15555550100).
    if (typeof value === 'number' && redactPhones(String(value)) !== String(value)) continue;
    if (mentionsEngagement(key) || mentionsEngagement(String(value))) continue;
    clean[key] = value;
  }
  return clean;
}

function isCallRecord(value: unknown): value is HotLeadCallRecord {
  return !!value && typeof value === 'object' && typeof (value as { state?: unknown }).state === 'string';
}

// The scalar fields a patch may set. An explicit list (not a spread) so a caller can never smuggle
// other keys, phone numbers included, into the lead row.
const SCALAR_FIELDS = ['state', 'jobKey', 'startedAt', 'updatedAt', 'memberCallSid', 'leadCallSid', 'outcome', 'attemptNo', 'memberId', 'leadPhoneMac', 'claimToken', 'deferral'] as const;

function scalarFields(record: Partial<HotLeadCallRecord>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of SCALAR_FIELDS) {
    if (record[field] !== undefined) out[field] = record[field];
  }
  return out;
}

class DynamoLeadCallStore implements LeadCallStore {
  async get(listId: string, leadId: string): Promise<HotLeadCallRecord | null> {
    const lead = await crmDb.getLeadById(listId, leadId, { consistentRead: true });
    const record = lead?.system?.[SYSTEM_KEY];
    return isCallRecord(record) ? record : null;
  }

  async create(listId: string, leadId: string, record: HotLeadCallRecord): Promise<boolean> {
    // meteredLegs, triedMemberIds and lastSequence are initialised because the conditional updates in
    // transition() cannot append to or set a path under a missing list/map.
    return crmDb.createLeadSystemRecordOnce(listId, leadId, SYSTEM_KEY, {
      ...scalarFields(record),
      meteredLegs: [...new Set(record.meteredLegs ?? [])],
      triedMemberIds: [...new Set(record.triedMemberIds)],
      lastSequence: { ...record.lastSequence },
    });
  }

  /**
   * In `patch`, `clear` removes the named fields (a next attempt starts without the previous call sid and outcome),
   * `meteredLegs` and `triedMemberIds` list the entries to ADD (a value already present fails the write) and `lastSequence` the entries to merge (not
   * replacements). `from` must name non-terminal states only; a terminal one makes it return false.
   * Consumer rule: because a terminal record is never revived, the webhook must meter a leg in the
   * same transition that makes the call terminal (or before it), never in a later one.
   * The call returns false, writing nothing, when the state is not in `from`, when a
   * lastSequence entry is not higher than the stored one for that CallSid, or when a leg is already
   * metered. So metering belongs in the same transition as the state change it accompanies: the one
   * caller that gets `true` meters, a replay gets `false` and does not.
   */
  async transition(
    listId: string,
    leadId: string,
    from: HotLeadCallState[],
    patch: HotLeadCallPatch,
  ): Promise<boolean> {
    // A terminal record is never revived: a caller bug that lists one in `from` is refused, not applied.
    if (from.length === 0 || from.some((s) => TERMINAL_STATES.includes(s))) return false;
    const legs: MeteredLeg[] = [...new Set(patch.meteredLegs ?? [])];
    return crmDb.updateLeadSystemRecordIf(listId, leadId, SYSTEM_KEY, {
      stateIn: from,
      set: { ...scalarFields(patch), updatedAt: new Date().toISOString() },
      remove: patch.clear,
      whenEquals: patch.ifAttemptNo === undefined ? undefined : { attemptNo: patch.ifAttemptNo },
      maxIn: patch.lastSequence ? { lastSequence: patch.lastSequence } : undefined,
      appendNew: { meteredLegs: legs, triedMemberIds: [...new Set(patch.triedMemberIds ?? [])] },
    });
  }

  async claimRetry(listId: string, leadId: string, jobKey: string, token: string): Promise<boolean> {
    return crmDb.updateLeadSystemRecordIf(listId, leadId, SYSTEM_KEY, {
      stateIn: ['finished'],
      set: { retryClaimToken: token, retryClaimedAt: new Date().toISOString() },
      whenEquals: { jobKey, outcome: 'lead_deferred' },
      whenAbsent: ['retryClaimToken'],
    });
  }

  async rescheduleRetry(listId: string, leadId: string, jobKey: string, deferral: { dueAt: string; firstDueAt?: string }): Promise<boolean> {
    return crmDb.updateLeadSystemRecordIf(listId, leadId, SYSTEM_KEY, {
      stateIn: ['finished'],
      set: { deferral: { dueAt: deferral.dueAt, count: 1, ...(deferral.firstDueAt ? { firstDueAt: deferral.firstDueAt } : {}) } },
      whenEquals: { jobKey, outcome: 'lead_deferred' },
      whenAbsent: ['retryClaimToken'],
    });
  }

  async releaseRetryClaim(listId: string, leadId: string, token: string, deferral: { dueAt: string; firstDueAt: string }): Promise<boolean> {
    return crmDb.updateLeadSystemRecordIf(listId, leadId, SYSTEM_KEY, {
      stateIn: ['finished'],
      set: { deferral: { dueAt: deferral.dueAt, count: 1, firstDueAt: deferral.firstDueAt } },
      remove: ['retryClaimToken', 'retryClaimedAt'],
      whenEquals: { retryClaimToken: token, outcome: 'lead_deferred' },
    });
  }

  async restartForRetry(listId: string, leadId: string, from: { jobKey: string; token: string }, fresh: RetryRestart): Promise<boolean> {
    return crmDb.updateLeadSystemRecordIf(listId, leadId, SYSTEM_KEY, {
      stateIn: ['finished'],
      whenEquals: { jobKey: from.jobKey, retryClaimToken: from.token },
      set: {
        state: 'dialing', attemptNo: 1, jobKey: fresh.jobKey, startedAt: fresh.startedAt, updatedAt: fresh.startedAt, memberId: fresh.memberId,
        claimToken: fresh.claimToken, leadPhoneMac: fresh.leadPhoneMac, triedMemberIds: [fresh.memberId], meteredLegs: [], lastSequence: {},
      },
      remove: ['memberCallSid', 'leadCallSid', 'outcome'],
    });
  }

  /** Timeline entry, best-effort: a failed write is logged and never fails the call flow. */
  async addEvent(
    listId: string,
    leadId: string,
    type: HotLeadCallEventType,
    detail: Record<string, string | number | boolean> = {},
  ): Promise<void> {
    try {
      await crmDb.addLeadEngagement(listId, leadId, {
        eventType: type,
        eventData: sanitizeDetail(detail),
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      // The error text of a lower layer can echo request data, so only its code or name is logged.
      console.warn(`[hotLeadCall] could not record ${type} for lead ${leadId}:`, errorCode(err) ?? (err instanceof Error ? err.name : 'error'));
    }
  }
}

let store: LeadCallStore | null = null;

export function getLeadCallStore(): LeadCallStore {
  if (!store) store = new DynamoLeadCallStore();
  return store;
}

/** Test-only: swap in a fake; null restores the real store. */
export function setLeadCallStoreForTests(replacement: LeadCallStore | null): void {
  store = replacement;
}
