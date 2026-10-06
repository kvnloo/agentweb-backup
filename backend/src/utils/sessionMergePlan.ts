import { pruneClickIds } from './leadSchema';
import { SESSION_JOURNEY_KEYS, SESSION_JOURNEY_COUNTER_KEY } from './sessionList';

/**
 * ENG-2312: turns one forward-lead event into the write plan db.mergeSessionLeadEvent applies
 * to an EXISTING session row. Pure, so the field-classification rules are testable without a
 * database. The classification is the whole contract:
 *
 *  - scalar engagement fields (dwellSec, activeSec, maxScrollPct, *_at, channel, ...):
 *    last-write-wins, per key; keys this event omits are never touched;
 *  - the cumulative journey group (SESSION_JOURNEY_KEYS): guarded by `eventCount` so an
 *    out-of-order older event cannot regress it. If this event carries no usable numeric
 *    counter there is nothing to guard on, so its journey keys fall back to last-write-wins
 *    rather than being dropped;
 *  - `forwardedAt` is NEVER written: it is the stored first-capture time, stamped once by the
 *    creating request (the existing merge paths preserve it the same way);
 *  - `source` is written only if this event NAMED one (callerSuppliedSource) — the handler
 *    defaults it to 'api' otherwise, and that default must not overwrite a real stored value.
 */
export function buildSessionMergePlan(input: {
  leadData: Record<string, any>;
  incomingCustomFields: Record<string, any>;
  callerSuppliedSource: boolean;
  /** The guarded group. Defaults to SESSION_JOURNEY_KEYS (forward-lead); the tracker ingest widens it
   *  with its own "latest state" keys (lastEvent, furthestStage, ...) so an out-of-order older event
   *  cannot regress them either. */
  journeyKeys?: readonly string[];
  touch?: { utm?: { source?: string; medium?: string }; clickIds?: unknown } & Record<string, any> | null;
}): {
  topLevel: Record<string, any>;
  topLevelIfNotExists: Record<string, any>;
  customFields: Record<string, any>;
  monotonic?: { counterKey: string; counter: number; fields: Record<string, any> };
} {
  const { leadData, incomingCustomFields, callerSuppliedSource, touch } = input;
  const journeyKeys = input.journeyKeys ?? SESSION_JOURNEY_KEYS;

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

  const journey: Record<string, any> = {};
  const customFields: Record<string, any> = {};
  for (const [k, v] of Object.entries(incomingCustomFields)) {
    if (v === undefined) continue;
    if (k === 'forwardedAt') continue;
    if (k === 'source' && !callerSuppliedSource) continue;
    if (journeyKeys.includes(k)) journey[k] = v;
    else customFields[k] = v;
  }

  const counter = journey[SESSION_JOURNEY_COUNTER_KEY];
  if (typeof counter === 'number' && Number.isFinite(counter)) {
    return {
      topLevel, topLevelIfNotExists, customFields,
      monotonic: { counterKey: SESSION_JOURNEY_COUNTER_KEY, counter, fields: journey },
    };
  }
  return { topLevel, topLevelIfNotExists, customFields: { ...customFields, ...journey } };
}
