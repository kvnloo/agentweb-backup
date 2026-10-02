/**
 * ENG-2280 (ENG-2046 A3): in-memory Meta write rate shaping.
 *
 * Meta allows ~4 budget edits per object per hour (error subcode 1487225) and
 * scores bursts of API activity before its abuse systems react. This shaper is
 * process-local by design (no persistence table): a restart forgets history,
 * which only makes it more permissive, and Meta's own limit still backstops it.
 *
 * - Budget-edit throttle: a 5th budget edit to one object inside an hour is
 *   never sent; the caller gets a retry-after.
 * - Coalescing: an edit that repeats the object's last sent budget values inside
 *   the window is answered without a Graph call and without consuming a slot.
 * - Burst score: read=1pt, write=3pt per ad account in a sliding window; at the
 *   threshold further calls are refused with a retry-after.
 */

export const META_BUDGET_EDITS_PER_HOUR = 4;
export const META_BUDGET_WINDOW_MS = 60 * 60 * 1000;
export const META_BURST_WINDOW_MS = 60 * 1000;
export const META_BURST_THRESHOLD = 60;
export const META_READ_POINTS = 1;
export const META_WRITE_POINTS = 3;
export const META_BUDGET_THROTTLE_SUBCODE = 1487225;

const BUDGET_FIELDS = ['daily_budget', 'lifetime_budget', 'spend_cap', 'budget_amount'] as const;

export type ShapeDecision =
  | { kind: 'send' }
  | { kind: 'coalesced'; objectId: string }
  | { kind: 'throttled'; reason: 'budget_edit_limit' | 'burst_limit'; retryAfterMs: number; message: string };

export function budgetEditFields(entityType: string, action: string, params: any): Record<string, unknown> | undefined {
  if (action !== 'UPDATE' || !['CAMPAIGN', 'AD_SET'].includes(entityType) || !params || typeof params !== 'object') return undefined;
  const fields: Record<string, unknown> = {};
  for (const field of BUDGET_FIELDS) if (params[field] !== undefined) fields[field] = params[field];
  return Object.keys(fields).length ? fields : undefined;
}

export class MetaWriteRateShaper {
  private budgetEdits = new Map<string, { sentAt: number[]; lastFields?: string }>();
  private burst = new Map<string, Array<{ at: number; points: number }>>();

  constructor(private readonly now: () => number = Date.now) {}

  private prune(accountId: string, at: number) {
    const events = (this.burst.get(accountId) || []).filter(e => at - e.at < META_BURST_WINDOW_MS);
    this.burst.set(accountId, events);
    return events;
  }

  private burstCheck(accountId: string, points: number, at: number): ShapeDecision | undefined {
    const events = this.prune(accountId, at);
    const score = events.reduce((sum, e) => sum + e.points, 0);
    if (score + points <= META_BURST_THRESHOLD) return undefined;
    const retryAfterMs = Math.max(1, META_BURST_WINDOW_MS - (at - events[0].at));
    return {
      kind: 'throttled', reason: 'burst_limit', retryAfterMs,
      message: `META_RATE_SHAPED: Meta API activity on this ad account is bursting (${score} of ${META_BURST_THRESHOLD} points in the last minute). Nothing was sent. Retry after ${Math.ceil(retryAfterMs / 1000)}s.`,
    };
  }

  /** Score a read. Reads are never refused here; they only feed the burst score. */
  recordRead(accountId: string) {
    const at = this.now();
    this.prune(accountId, at).push({ at, points: META_READ_POINTS });
  }

  /** Decide a write. 'send' commits the attempt (a slot + burst points); call before the Graph write. */
  shapeWrite(accountId: string, entityType: string, action: string, objectId: string | undefined, params: any): ShapeDecision {
    const at = this.now();
    const budget = objectId ? budgetEditFields(entityType, action, params) : undefined;
    const key = `${entityType}:${objectId}`;
    let record: { sentAt: number[]; lastFields?: string } | undefined;
    let fingerprint: string | undefined;
    if (budget) {
      record = this.budgetEdits.get(key) || { sentAt: [] };
      record.sentAt = record.sentAt.filter(t => at - t < META_BUDGET_WINDOW_MS);
      this.budgetEdits.set(key, record);
      fingerprint = JSON.stringify(Object.keys(budget).sort().map(k => [k, budget[k]]));
      if (record.sentAt.length && record.lastFields === fingerprint) return { kind: 'coalesced', objectId: objectId! };
      if (record.sentAt.length >= META_BUDGET_EDITS_PER_HOUR) {
        const retryAfterMs = Math.max(1, META_BUDGET_WINDOW_MS - (at - record.sentAt[0]));
        return {
          kind: 'throttled', reason: 'budget_edit_limit', retryAfterMs,
          message: `META_BUDGET_THROTTLED: ${objectId} already had ${META_BUDGET_EDITS_PER_HOUR} budget edits in the last hour (Meta's limit, subcode ${META_BUDGET_THROTTLE_SUBCODE}). Nothing was sent. Retry after ${Math.ceil(retryAfterMs / 60000)} min, or combine the remaining changes into one edit then.`,
        };
      }
    }
    const burst = this.burstCheck(accountId, META_WRITE_POINTS, at);
    if (burst) return burst;
    this.burst.get(accountId)!.push({ at, points: META_WRITE_POINTS });
    if (record) {
      record.sentAt.push(at);
      record.lastFields = fingerprint;
    }
    return { kind: 'send' };
  }

  /** A write Meta rejected did not change the budget: release its slot so it isn't double-counted. */
  releaseBudgetEdit(entityType: string, objectId: string | undefined) {
    const record = objectId ? this.budgetEdits.get(`${entityType}:${objectId}`) : undefined;
    if (!record?.sentAt.length) return;
    record.sentAt.pop();
    record.lastFields = undefined;
  }
}

export const metaWriteRateShaper = new MetaWriteRateShaper();
