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

/** Shown wherever a sequence binding / enrolment names a session list (ENG-2311). */
export const SESSION_LIST_SEQUENCE_ERROR =
  'Session lists hold per-visitor session telemetry and cannot be bound to or enrolled in a sequence.';

/**
 * Shown wherever a landing page's lead capture would be bound to a session list (ENG-2323). A page's
 * form writes real contacts; into a session list they would become visit rows that are suppressed
 * (no sequences / sync / alerts) and excluded from the Inbox and every contact aggregate.
 */
export const SESSION_LIST_LEAD_CAPTURE_ERROR =
  'Session lists hold website-visit telemetry and cannot be a landing page\'s lead list. Choose a regular lead list.';

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
  /**
   * ONLY set by resolveIngestSessionIdentity when it REPLACED the device-supplied start (see there):
   * the other starts this session may already have a row under, most likely first. The ingest probes
   * them (exact-key reads) before creating under `sessionStartMs`; nothing else reads this.
   */
  probeStartsMs?: number[];
}

/** The sessionId / sessionStartMs of a body (top level, or inside `customFields`), shape-checked only: no window. */
function readSessionFields(body: unknown): { sessionId: string; start: number } | null {
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
  return { sessionId: rawId, start };
}

const startInWindow = (start: number, nowMs: number): boolean =>
  start >= nowMs - SESSION_START_PAST_MS && start <= nowMs + SESSION_START_FUTURE_MS;

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
  const f = readSessionFields(body);
  if (!f || !startInWindow(f.start, nowMs)) return null;
  return { sessionId: f.sessionId, sessionStartMs: f.start };
}

/** ENG-2324: width of the generations a substituted start is drawn from. <= the 48h window, so every substitute is inside it. */
export const SESSION_START_GENERATION_MS = 24 * 60 * 60 * 1000;

/**
 * ENG-2324: a stand-in for a device start that is not usable, derived from the sessionId and the
 * server clock only.
 *
 * Generation g(now) = the latest instant <= now of the form k*24h + phase, phase = hash(sessionId)
 * mod 24h. It is therefore in (now-24h, now]: always inside the window, always a real 13-digit
 * time, never ahead of the server clock, and no more than a day behind it. It is identical for
 * every event of the session until `now` passes the session's own phase instant (once a day,
 * at a point the session id picks, not a shared midnight); after that the generation advances by
 * 24h. `probeStartsMs` lists where the session may already have its row: the device start when it
 * had aged out of the window (`agedOutDeviceStart`: the row was created while it was inside) and the
 * two previous generations (a session of up to 48h).
 * A caller cannot choose anything the window did not already let it choose: the phase picks a
 * position inside the last 24h, an in-window sessionStartMs picks one inside the last 48h.
 */
export function substituteSessionStart(sessionId: string, nowMs: number, agedOutDeviceStart?: number): SessionIdentity {
  const phase = parseInt(
    crypto.createHash('sha256').update(`start:${sessionId.toLowerCase()}`).digest('hex').slice(0, 8), 16,
  ) % SESSION_START_GENERATION_MS;
  const sessionStartMs = Math.floor((nowMs - phase) / SESSION_START_GENERATION_MS) * SESSION_START_GENERATION_MS + phase;
  return {
    sessionId,
    sessionStartMs,
    probeStartsMs: [
      ...(agedOutDeviceStart !== undefined ? [agedOutDeviceStart] : []),
      sessionStartMs - SESSION_START_GENERATION_MS,
      sessionStartMs - 2 * SESSION_START_GENERATION_MS,
    ],
  };
}

/**
 * ENG-2324: the PUBLIC tracker ingest's identity parser. Same as resolveSessionIdentity when the
 * start is inside the window; but a well-formed start OUTSIDE it (a device clock that is wrong, a tab
 * left open for days) is no longer a rejection — that lost every event of the session. It is
 * replaced by substituteSessionStart. forward-lead keeps the strict resolveSessionIdentity.
 *
 * `body.clientNowMs` (the SDK's Date.now() when it built the event; optional) makes the decision
 * sticky for a device whose clock is AHEAD by more than the 5 minutes: such a start is out of the
 * window now but enters it as the clock catches up, which would move the session from its
 * substitute row to a new one mid-session. A device that is ahead is ahead for the whole session,
 * so it is substituted for the whole session. The value only ever pushes a session onto the
 * substitute (which is bounded), never off the window rule, so a lying caller gains nothing.
 */
export function resolveIngestSessionIdentity(body: unknown, nowMs: number = Date.now()): SessionIdentity | null {
  const f = readSessionFields(body);
  if (!f) return null;
  const clientNow = (body as Record<string, unknown>).clientNowMs;
  const deviceAhead = typeof clientNow === 'number' && clientNow > nowMs + SESSION_START_FUTURE_MS;
  if (!deviceAhead && startInWindow(f.start, nowMs)) return { sessionId: f.sessionId, sessionStartMs: f.start };
  return substituteSessionStart(f.sessionId, nowMs, f.start < nowMs - SESSION_START_PAST_MS ? f.start : undefined);
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
 * that only grows within a session) — see db.mergeSessionLeadEvent. The tracker ingest builds its
 * single guarded group from this; forward-lead uses SESSION_GUARD_GROUPS below.
 */
export const SESSION_JOURNEY_KEYS: readonly string[] = ['journey', 'eventCount', 'clickLog', 'clickCount', 'showsClicked'];
export const SESSION_JOURNEY_COUNTER_KEY = 'eventCount';

/**
 * A set of customFields keys written together under ONE monotonic counter (see db.mergeSessionLeadEvent).
 * Each group is its own UpdateItem, so a stale group never discards another group's newer data.
 */
export interface SessionGuardGroup { counterKey: string; fields: readonly string[] }

/**
 * forward-lead's default guard groups (the DramaBreak LPs post flat fields, not the SDK's cumulative ones):
 *  - PROGRESS, keyed by `eventCount`: the funnel state. furthestStage / lastEvent / lastEp are "latest state",
 *    so an out-of-order older event must not regress them (funnel analytics read furthestStage).
 *  - CLICKS, keyed by `clickCount`: ONLY click events carry these. They must NOT share PROGRESS's counter:
 *    a click event (eventCount N) overtaken by a later non-click event (N+1) would have its whole group
 *    rejected and the click data lost. clickCount only grows when a click happens, so it orders them.
 * A group whose counter is absent / non-numeric in the incoming event falls back to last-write-wins.
 */
export const SESSION_GUARD_GROUPS: readonly SessionGuardGroup[] = [
  { counterKey: 'eventCount', fields: ['journey', 'eventCount', 'furthestStage', 'lastEvent', 'lastEp'] },
  { counterKey: 'clickCount', fields: ['clickLog', 'clickCount', 'showsClicked', 'lastClickLabel', 'lastClickShow', 'lastClickSection', 'lastClickUrl'] },
];
