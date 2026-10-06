import { pruneClickIds } from './leadSchema';
import { SESSION_GUARD_GROUPS, SESSION_JOURNEY_COUNTER_KEY } from './sessionList';

/**
 * ENG-2312: turns one forward-lead event into the write plan db.mergeSessionLeadEvent applies
 * to an EXISTING session row. Pure, so the field-classification rules are testable without a
 * database. The classification is the whole contract:
 *
 *  - scalar engagement fields (dwellSec, activeSec, maxScrollPct, *_at, channel, ...):
 *    last-write-wins, per key; keys this event omits are never touched;
 *  - the guard groups (SESSION_GUARD_GROUPS: PROGRESS by `eventCount`, CLICKS by `clickCount`),
 *    each independently guarded so an out-of-order older event cannot regress it. If this event
 *    carries no usable numeric counter for a group there is nothing to guard on, so that group's
 *    keys fall back to last-write-wins rather than being dropped;
 *  - `forwardedAt` is NEVER written: it is the stored first-capture time, stamped once by the
 *    creating request (the existing merge paths preserve it the same way);
 *  - `source` is written only if this event NAMED one (callerSuppliedSource) — the handler
 *    defaults it to 'api' otherwise, and that default must not overwrite a real stored value.
 */
export interface MonotonicGroup { counterKey: string; counter: number; fields: Record<string, any> }

export function buildSessionMergePlan(input: {
  leadData: Record<string, any>;
  incomingCustomFields: Record<string, any>;
  callerSuppliedSource: boolean;
  /** Override: ONE group guarded by eventCount (the tracker ingest passes its wider "latest state" set;
   *  its output shape is the single `monotonic` object it always was). Omitted by forward-lead, which
   *  gets SESSION_GUARD_GROUPS and an array of independently guarded groups. */
  journeyKeys?: readonly string[];
  touch?: { utm?: { source?: string; medium?: string }; clickIds?: unknown } & Record<string, any> | null;
}): {
  topLevel: Record<string, any>;
  topLevelIfNotExists: Record<string, any>;
  customFields: Record<string, any>;
  monotonic?: MonotonicGroup | MonotonicGroup[];
} {
  const { leadData, incomingCustomFields, callerSuppliedSource, touch } = input;
  const groups = input.journeyKeys
    ? [{ counterKey: SESSION_JOURNEY_COUNTER_KEY, fields: input.journeyKeys }]
    : SESSION_GUARD_GROUPS;

  const topLevel: Record<string, any> = {};
  // Non-empty only, like the existing merge paths. `linkedin` and `email` are deliberately not
  // merged: both are GSI keys that createLead canonicalises, and a session row never gains
  // either after creation.
  for (const f of ['firstName', 'lastName', 'phone', 'company', 'title', 'notes'] as const) {
    const v = typeof leadData[f] === 'string' ? leadData[f].trim() : '';
    if (v) topLevel[f] = v;
  }

  const topLevelIfNotExists: Record<string, any> = {};
  for (const f of ['metaFbp', 'clientIp', 'clientUserAgent'] as const) {
    if (leadData[f]) topLevelIfNotExists[f] = leadData[f];
  }
  if (touch) {
    topLevel.lastTouch = leadData.lastTouch ?? touch;
    topLevelIfNotExists.firstTouch = touch;
    if (touch.utm?.source) topLevelIfNotExists.utmSource = touch.utm.source;
    if (touch.utm?.medium) topLevelIfNotExists.utmMedium = touch.utm.medium;
    const clickIds = pruneClickIds(touch.clickIds);
    if (clickIds) topLevelIfNotExists.clickIds = clickIds;
  }

  const grouped: Array<Record<string, any>> = groups.map(() => ({}));
  const customFields: Record<string, any> = {};
  for (const [k, v] of Object.entries(incomingCustomFields)) {
    if (v === undefined) continue;
    if (k === 'forwardedAt') continue;
    if (k === 'source' && !callerSuppliedSource) continue;
    const gi = groups.findIndex((g) => g.fields.includes(k));
    if (gi >= 0) grouped[gi][k] = v;
    else customFields[k] = v;
  }

  const monotonic: MonotonicGroup[] = [];
  groups.forEach((g, i) => {
    const counter = grouped[i][g.counterKey];
    if (typeof counter === 'number' && Number.isFinite(counter)) monotonic.push({ counterKey: g.counterKey, counter, fields: grouped[i] });
    else Object.assign(customFields, grouped[i]); // nothing to guard on: last-write-wins, not dropped
  });
  if (monotonic.length === 0) return { topLevel, topLevelIfNotExists, customFields };
  return { topLevel, topLevelIfNotExists, customFields, monotonic: input.journeyKeys ? monotonic[0] : monotonic };
}
