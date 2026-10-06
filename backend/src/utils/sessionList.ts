/**
 * ENG-2311: `listType: 'session'` marks a lead list whose rows are landing-page visitor
 * SESSIONS (one row per session, written by custom LPs through POST /api/webhooks/forward-lead),
 * not people or deals.
 *
 * Every decision of the form "is this a session list?" goes through this module so the answer
 * cannot drift between the write path (ENG-2312's atomic upsert), the side-effect gates and the
 * cross-list readers that must exclude these rows.
 *
 * ⚠ Only ever call these with a list row READ FROM THE DATABASE. `listType` is set-once and
 * server-owned; forward-lead is public and CORS-open, so a request body must never be what
 * decides this.
 */
export function isSessionList(list: { listType?: unknown } | null | undefined): boolean {
  return list?.listType === 'session';
}

/**
 * The one policy gate for "this lead write must not cause outbound or cross-system effects":
 * HubSpot/Attio sync, drip-sequence enrolment, auto-draft/auto-send, owner alerts and Slack
 * notifications, the roadmap email, Meta CAPI and the first-touch attribution event.
 * A session row is telemetry — one per visit, thousands per list — so each of those would be
 * a flood (or, for email, a message to a synthetic address). Named separately from
 * isSessionList so a future list type that also wants silence changes ONE function.
 */
export function suppressLeadSideEffects(list: { listType?: unknown } | null | undefined): boolean {
  return isSessionList(list);
}

/** Shown wherever a sequence binding / enrolment names a session list (ENG-2311). */
export const SESSION_LIST_SEQUENCE_ERROR =
  'Session lists hold per-visitor session telemetry and cannot be bound to or enrolled in a sequence.';

/**
 * Drops session lists from a list-of-lists before a cross-list AGGREGATE (lead counts,
 * attribution coverage, "recent leads" rankers, the Inbox). One synthetic-email row per
 * visit would otherwise swamp every total and eat shared scan caps. Lists with an unset or
 * any other listType pass through untouched, so results for sales/customers lists never change.
 * Tolerates a non-array (some call sites default a failed read to undefined/null).
 */
export function excludeSessionLists<T extends { listType?: unknown }>(lists: T[] | null | undefined): T[] {
  return Array.isArray(lists) ? lists.filter((l) => !isSessionList(l)) : [];
}
