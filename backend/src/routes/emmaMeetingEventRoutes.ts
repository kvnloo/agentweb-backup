/**
 * ENG-2840 (W2-9): the /api/emma routes behind four MCP reads of the caller's meetings and events: `fathom_get_meetings`,
 * `fathom_get_transcript`, `luma_list_events`, `luma_get_guests` (mcp/server/meetingEventReadTools.ts).
 *
 * Each route checks the body by name and by value (the same checks as the MCP tools, exported from here), then runs Emma's own tool through
 * Emma's own registry, exactly as her dispatcher does, with `{ userId }` as the only context, `userId` being `req.user.userId`. No identity
 * is ever read from the body. Emma's four tools read nothing else from the context (`context?.userId`); the registry adds its own checks
 * for that user (an evaluation sandbox's policy, an anonymous account).
 *  - Fathom: the caller's OWN connection only (getFathomAccessToken(userId)); no sharing, no account choice.
 *  - Luma: the caller's own calendar key or one an organization member shared, as in Emma (`calendar_id` picks among those only). A
 *    share-link visitor is refused, as Emma refuses them these two tools (SHARE_VISITOR_BLOCKED_TOOLS). `include_phone` is never passed, so
 *    no phone number is read; a `phone_number` field is removed from the answer as well.
 *  - Emma answers "no Luma key" with `success: true, nothing_pulled: true` (an instruction to her own model to carry on in a browser). Here
 *    that is a plain refusal: Luma is not connected.
 * A refusal is HTTP 200 `{ success: false, message }` (Emma's own words) or a 400 for a bad body; an unexpected failure is a 500 with a fixed
 * text. Budget class: these routes are registered on the emmaApi router, after its auth and token-budget middleware.
 */
import type { Router, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { EvaluationDenied } from '../services/evaluationPolicy';

// ─────────────────────────────────────────────────────────────────────────────────────────────────── argument checks

export type ArgCheck = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

/** What each route takes (and, with the MCP-only options, what each MCP tool takes). */
export const ROUTE_INPUTS = {
  fathom_get_meetings: ['created_after', 'created_before'],
  fathom_get_transcript: ['recording_id'],
  luma_list_events: ['after', 'before', 'limit', 'cursor', 'calendar_id'],
  luma_get_guests: ['event', 'approval_status', 'registered_after', 'include_registration_answers', 'answer_labels', 'max_guests', 'cursor', 'calendar_id'],
} as const;
export type MeetingEventTool = keyof typeof ROUTE_INPUTS;

/** Emma's own list (emma/lumaTools.ts GUEST_STATUSES). */
export const LUMA_GUEST_STATUSES = ['approved', 'session', 'pending_approval', 'invited', 'declined', 'waitlist'] as const;
export const LUMA_EVENT_ID_RE = /^evt-[A-Za-z0-9]{1,60}$/;
export const LUMA_CALENDAR_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const LUMA_CURSOR_RE = /^[A-Za-z0-9._~:=+/-]{1,200}$/;
export const LUMA_MAX_EVENTS = 100;
/** Emma's hard cap per call (HARD_MAX_GUESTS); she lowers it further when answers are asked for. */
export const LUMA_MAX_GUESTS = 60;
export const LUMA_MAX_ANSWER_LABELS = 5;
export const LUMA_MAX_ANSWER_LABEL_CHARS = 40;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-](\d{2}):(\d{2}))?)?$/;
// Control, line-separator, zero-width and bidirectional characters: never part of a label an agent means.
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

const absent = (value: unknown) => value === undefined || value === null;

/**
 * A strict ISO 8601 date or date-time (no offset = UTC, as Emma reads it), as a full UTC timestamp. Refuses what `Date.parse` would roll
 * over (2026-02-30, 24:00) and anything that is not this shape.
 */
export function strictIsoUtc(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const m = ISO_RE.exec(value);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 1970 || year > 2100 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59 || (m[6] !== undefined && Number(m[6]) > 59))) return null;
  if (m[8] !== undefined && (Number(m[8]) > 14 || Number(m[9]) > 59)) return null;
  const candidate = m[4] === undefined ? `${value}T00:00:00Z` : m[7] === undefined ? `${value}Z` : value;
  const ms = Date.parse(candidate);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** A positive safe integer, or a string of its digits (converted strictly). */
export function positiveSafeInteger(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function wholeNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

const ISO_HINT = 'must be an ISO 8601 date or date-time, such as 2026-11-01 or 2026-11-01T09:00:00Z';

function dates(body: Record<string, unknown>, keys: readonly string[], out: Record<string, unknown>): string | null {
  for (const key of keys) {
    if (absent(body[key])) continue;
    const iso = strictIsoUtc(body[key]);
    if (!iso) return `${key} ${ISO_HINT}`;
    out[key] = iso;
  }
  return null;
}

function lumaCommon(body: Record<string, unknown>, out: Record<string, unknown>): string | null {
  if (!absent(body.cursor)) {
    if (typeof body.cursor !== 'string' || !LUMA_CURSOR_RE.test(body.cursor)) return 'cursor must be the next_cursor of an earlier answer, unchanged';
    out.cursor = body.cursor;
  }
  if (!absent(body.calendar_id)) {
    if (typeof body.calendar_id !== 'string' || !LUMA_CALENDAR_ID_RE.test(body.calendar_id)) return 'calendar_id must be the id of a connected Luma calendar (letters, digits, - or _)';
    out.calendar_id = body.calendar_id;
  }
  return null;
}

/** The body of one route (or the arguments of one MCP tool without its MCP-only options): known names only, every value checked. */
export function checkArgs(tool: MeetingEventTool, body: unknown): ArgCheck {
  if (absent(body)) body = {};
  if (typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'the arguments must be an object' };
  const b = body as Record<string, unknown>;
  const inputs: readonly string[] = ROUTE_INPUTS[tool];
  const unknown = Object.keys(b).filter((key) => !inputs.includes(key));
  if (unknown.length > 0) return { ok: false, error: `${unknown.map((k) => `"${k.slice(0, 40)}"`).join(', ')} ${unknown.length > 1 ? 'are not inputs' : 'is not an input'}. The inputs are: ${inputs.join(', ')}` };
  const out: Record<string, unknown> = {};
  let error: string | null = null;
  switch (tool) {
    case 'fathom_get_meetings': {
      error = dates(b, ['created_after', 'created_before'], out);
      if (!error && out.created_after && out.created_before && String(out.created_after) > String(out.created_before)) error = 'created_after must not be later than created_before';
      break;
    }
    case 'fathom_get_transcript': {
      const id = positiveSafeInteger(b.recording_id);
      if (id === null) error = 'recording_id is required and must be a positive whole number, a recording_id from fathom_get_meetings';
      else out.recording_id = id;
      break;
    }
    case 'luma_list_events': {
      error = dates(b, ['after', 'before'], out);
      if (!error && out.after && out.before && String(out.after) > String(out.before)) error = 'after must not be later than before';
      if (!error && !absent(b.limit)) {
        const limit = wholeNumber(b.limit, 1, LUMA_MAX_EVENTS);
        if (limit === null) error = `limit must be a whole number from 1 to ${LUMA_MAX_EVENTS}`;
        else out.limit = limit;
      }
      if (!error) error = lumaCommon(b, out);
      break;
    }
    case 'luma_get_guests': {
      if (typeof b.event !== 'string' || !LUMA_EVENT_ID_RE.test(b.event)) {
        error = 'event is required and must be an event id (evt-...), as luma_list_events returns it; links are not accepted';
        break;
      }
      out.event = b.event;
      if (!absent(b.approval_status)) {
        if (!(LUMA_GUEST_STATUSES as readonly unknown[]).includes(b.approval_status)) { error = `approval_status must be one of ${LUMA_GUEST_STATUSES.join(', ')}`; break; }
        out.approval_status = b.approval_status;
      }
      error = dates(b, ['registered_after'], out);
      if (error) break;
      if (!absent(b.include_registration_answers)) {
        if (typeof b.include_registration_answers !== 'boolean') { error = 'include_registration_answers must be true or false'; break; }
        out.include_registration_answers = b.include_registration_answers;
      }
      if (!absent(b.answer_labels)) {
        const labels = b.answer_labels;
        if (!Array.isArray(labels) || labels.length > LUMA_MAX_ANSWER_LABELS
          || !labels.every((l) => typeof l === 'string' && l.trim() !== '' && l.length <= LUMA_MAX_ANSWER_LABEL_CHARS && !UNSAFE_TEXT_RE.test(l))) {
          error = `answer_labels must be a list of at most ${LUMA_MAX_ANSWER_LABELS} words, each 1 to ${LUMA_MAX_ANSWER_LABEL_CHARS} characters`;
          break;
        }
        out.answer_labels = (labels as string[]).map((l) => l.trim());
      }
      if (!absent(b.max_guests)) {
        const max = wholeNumber(b.max_guests, 1, LUMA_MAX_GUESTS);
        if (max === null) { error = `max_guests must be a whole number from 1 to ${LUMA_MAX_GUESTS}`; break; }
        out.max_guests = max;
      }
      error = lumaCommon(b, out);
      break;
    }
  }
  return error ? { ok: false, error } : { ok: true, args: out };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────── the routes

export const LUMA_NOT_CONNECTED_MESSAGE =
  'Luma is not connected: no Luma calendar API key is connected to your account or shared with your organization. Connect one on the '
  + '"Luma API key" card in Settings > Login Credentials (it needs Luma Plus). Nothing was read';
export const LUMA_KEY_REJECTED_MESSAGE =
  'Luma rejected the connected calendar API key (revoked, for another calendar, or the Luma Plus plan lapsed). Replace it on the '
  + '"Luma API key" card in Settings > Login Credentials. Nothing was read';

function userId(req: Request): string {
  return (req as AuthenticatedRequest).user.userId;
}

/** Emma's own tool through Emma's own registry, as her dispatcher runs it, for this user only. */
async function runEmmaTool(name: MeetingEventTool, args: Record<string, unknown>, caller: string): Promise<any> {
  if (name.startsWith('fathom_')) await import('../emma/fathomTools');
  else await import('../emma/lumaTools');
  const { emmaToolRegistry } = await import('../emma/registry');
  return emmaToolRegistry.execute(name, args, { userId: caller });
}

const FAILURE_TEXT: Record<MeetingEventTool, string> = {
  fathom_get_meetings: 'The Fathom meetings could not be read',
  fathom_get_transcript: 'The Fathom transcript could not be read',
  luma_list_events: 'The Luma events could not be read',
  luma_get_guests: 'The Luma guests could not be read',
};

function route(router: Router, path: string, tool: MeetingEventTool) {
  router.post(path, async (req: Request, res: Response) => {
    const checked = checkArgs(tool, req.body);
    if (!checked.ok) return res.status(400).json({ message: checked.error });
    const luma = tool.startsWith('luma_');
    // Emma never runs these for a share-link visitor (SHARE_VISITOR_BLOCKED_TOOLS): an org-shared key and guests' answers would be reachable.
    if (luma && (req as AuthenticatedRequest).restrictionProfile) {
      return res.status(403).json({ message: 'Luma is not available to a shared-link visitor' });
    }
    try {
      const result = await runEmmaTool(tool, checked.args, userId(req));
      if (luma && result && typeof result === 'object' && result.nothing_pulled === true) {
        return res.json({ success: false, connected: false, message: result.reason === 'key_rejected' ? LUMA_KEY_REJECTED_MESSAGE : LUMA_NOT_CONNECTED_MESSAGE });
      }
      if (tool === 'luma_get_guests' && result?.success === true && Array.isArray(result.guests)) {
        result.guests = result.guests.map((g: any) => {
          if (!g || typeof g !== 'object') return g;
          const { phone_number: _phone, ...rest } = g;
          return rest;
        });
      }
      res.json(result);
    } catch (err: any) {
      if (err instanceof EvaluationDenied) {
        return res.status(403).json({ message: 'This tool is not available in this sandbox workspace' });
      }
      console.error(`[emma] ${path} failed:`, err?.message);
      res.status(500).json({ message: FAILURE_TEXT[tool] });
    }
  });
}

/** Registers the four routes on the emmaApi router (after its authentication and token-budget middleware). */
export function registerMeetingEventRoutes(router: Router): void {
  route(router, '/fathom-meetings', 'fathom_get_meetings');
  route(router, '/fathom-transcript', 'fathom_get_transcript');
  route(router, '/luma-events', 'luma_list_events');
  route(router, '/luma-guests', 'luma_get_guests');
}
