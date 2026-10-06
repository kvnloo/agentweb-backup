import * as crypto from 'crypto';

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

// ─── ENG-2312: session identity → deterministic lead id ─────────────────────────────────

const SESSION_ID_RE = /^[a-z0-9-]{8,64}$/i;
const SESSION_START_PAST_MS = 48 * 60 * 60 * 1000;
const SESSION_START_FUTURE_MS = 5 * 60 * 1000;

export interface SessionIdentity {
  sessionId: string;
  sessionStartMs: number;
}

/**
 * Pulls the session identity out of a forward-lead body: `sessionId` / `sessionStartMs` at the
 * top level, or inside `customFields` (the shape the LPs post today). Returns null unless BOTH
 * are present and valid, and the caller then keeps the legacy (email-index) behaviour — so an
 * LP that has not yet been updated to send `sessionStartMs` is unaffected.
 *
 * `sessionStartMs` is accepted only inside [now-48h, now+5min]. Two reasons it is bounded: it
 * becomes the 13-digit time prefix of the lead id that `getLeadsByListId` sorts newest-first
 * on, so an arbitrary value from this public, CORS-open endpoint could pin a row to the top
 * (or bottom) of a customer's list forever; and a session older than 48h is not a live one.
 * The 5 minutes tolerate clock skew between the visitor's browser and this server.
 *
 * This only PARSES caller input. Whether to act on it is decided separately, by
 * isSessionList(<list read from the DB>) — a body can never opt a list into this path.
 */
export function resolveSessionIdentity(
  body: unknown,
  nowMs: number = Date.now(),
): SessionIdentity | null {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, any>;
  const cf = (b.customFields && typeof b.customFields === 'object' ? b.customFields : {}) as Record<string, any>;

  const rawId = b.sessionId !== undefined ? b.sessionId : cf.sessionId;
  if (typeof rawId !== 'string' || !SESSION_ID_RE.test(rawId)) return null;

  const rawStart = b.sessionStartMs !== undefined ? b.sessionStartMs : cf.sessionStartMs;
  let start: number;
  if (typeof rawStart === 'number') start = rawStart;
  else if (typeof rawStart === 'string' && /^\d{1,16}$/.test(rawStart)) start = Number(rawStart);
  else return null;
  if (!Number.isSafeInteger(start)) return null;
  if (start < nowMs - SESSION_START_PAST_MS || start > nowMs + SESSION_START_FUTURE_MS) return null;

  return { sessionId: rawId, sessionStartMs: start };
}

/**
 * `lead_<sessionStartMs>_<12 hex>`: one id per (list, session), so concurrent events for one
 * session all target ONE (listId, leadId) item and a conditional put resolves the race.
 *
 * It keeps the ordinary `lead_<13-digit ms>_` shape ON PURPOSE. getLeadsByListId pages with
 * ScanIndexForward:false and relies on a time-prefixed leadId for recency; ENG-2082/2123's
 * `lead_ph_<sha>` ids sort above every digit and pinned rows to the top of a list. Within the
 * supported window the prefix is always 13 digits, so these sort among ordinary ids by the
 * session's start time. Nothing in the repo parses a leadId (verified by grep).
 * sessionId is lower-cased so the hash cannot differ by the LP's casing; listId scopes it.
 */
export function sessionLeadId(listId: string, identity: SessionIdentity): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${listId}:${identity.sessionId.toLowerCase()}`)
    .digest('hex')
    .slice(0, 12);
  return `lead_${identity.sessionStartMs}_${hash}`;
}

/**
 * The cumulative "journey" group: each event carries the whole journey so far, so an
 * out-of-order older event must not overwrite a newer one. Guarded on `eventCount` (a counter
 * that only grows within a session) — see db.mergeSessionLeadEvent.
 */
export const SESSION_JOURNEY_KEYS: readonly string[] = ['journey', 'eventCount', 'clickLog', 'clickCount', 'showsClicked'];
export const SESSION_JOURNEY_COUNTER_KEY = 'eventCount';
