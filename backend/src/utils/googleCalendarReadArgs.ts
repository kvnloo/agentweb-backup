/**
 * ENG-2840 (W2-10): the arguments of the three Google Calendar reads outside agents may call, under Emma's own names
 * (`google_calendar_list_events`, `google_calendar_get_event`, `google_calendar_list_calendars`), and their check.
 *
 * One check, used twice: by the MCP tools (mcp/server/googleCalendarReadTools.ts) before anything is called, and again by the route they
 * self-call (`POST /api/emma/google-calendar-read`, routes/emmaGoogleCalendarRoutes.ts), which any portal token can reach directly. The
 * route hands Emma's tool ONLY the object this returns, never the request body.
 *
 * Why every value is checked (research `eng-2840-w210-research-2026-11-27.md` section 7): Emma's tools pass the values to Google as they
 * come (`max_results` is not even type-checked: NaN or a negative number reaches Google). `calendar_id` and `event_id` become URL path
 * segments; googleapis percent-encodes reserved characters but leaves `.` alone, so a calendar id of `..` would resolve to another Calendar
 * API path. So ids are a fixed character set, and a calendar id needs at least one letter or digit. Dates are full date-times with a zone,
 * as Google's RFC 3339 `timeMin` / `timeMax` require, sent on in UTC. The range is filled in here (`time_min` defaults to now, `time_max` to
 * 7 days after `time_min`) and bounded (at most 92 days), so the range checked is the range read.
 */

export const GOOGLE_CALENDAR_READ_TOOLS = ['google_calendar_list_events', 'google_calendar_get_event', 'google_calendar_list_calendars'] as const;
export type GoogleCalendarReadTool = (typeof GOOGLE_CALENDAR_READ_TOOLS)[number];

/** What each tool takes. */
export const GOOGLE_CALENDAR_READ_INPUTS: Record<GoogleCalendarReadTool, readonly string[]> = {
  google_calendar_list_events: ['time_min', 'time_max', 'calendar_id', 'max_results', 'query'],
  google_calendar_get_event: ['event_id', 'calendar_id'],
  google_calendar_list_calendars: [],
};

export const CALENDAR_MAX_RANGE_DAYS = 92;
export const CALENDAR_DEFAULT_RANGE_DAYS = 7;
export const CALENDAR_MAX_RESULTS = 100;
export const CALENDAR_MAX_QUERY_CHARS = 200;
export const CALENDAR_MAX_ID_CHARS = 256;
export const CALENDAR_MAX_EVENT_ID_CHARS = 1024;
/** `primary`, or an id such as `name@example.com`, `c_abc123@group.calendar.google.com` or `en.usa#holiday@group.v.calendar.google.com`. */
export const CALENDAR_ID_RE = /^[A-Za-z0-9._@#-]{1,256}$/;
/** Google event ids are base32hex; a recurring event's instance adds `_` and its start (`abc123_20261127T100000Z`). */
export const CALENDAR_EVENT_ID_RE = /^[A-Za-z0-9_]{1,1024}$/;

const DAY_MS = 86_400_000;
// Control, line-separator, zero-width and bidirectional characters: never part of a search an agent means.
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;
const DATE_TIME_HINT = 'must be an ISO 8601 date-time with a zone, such as 2026-11-01T09:00:00Z or 2026-11-01T09:00:00+05:30';

export type CalendarArgCheck = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };
export type CalendarBodyCheck = { ok: true; tool: GoogleCalendarReadTool; args: Record<string, unknown> } | { ok: false; error: string };

const absent = (value: unknown) => value === undefined || value === null;

/**
 * A strict ISO 8601 date-time WITH a zone (`Z` or `+hh:mm` / `-hh:mm`), as epoch milliseconds; null for anything else. Refuses a date
 * alone, a date-time without a zone, and what `Date.parse` would roll over (2026-02-30, 24:00).
 */
export function zonedDateTimeMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const m = DATE_TIME_RE.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  if (year < 1970 || year > 2100 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offsetMinutes = 0;
  if (m[8] !== 'Z') {
    const [offsetHours, offsetMins] = [Number(m[10]), Number(m[11])];
    if (offsetHours > 14 || offsetMins > 59) return null;
    offsetMinutes = (m[9] === '-' ? -1 : 1) * (offsetHours * 60 + offsetMins);
  }
  const millis = Number((m[7] ?? '').padEnd(3, '0').slice(0, 3));
  return Date.UTC(year, month - 1, day, hour, minute, second, millis) - offsetMinutes * 60_000;
}

function wholeNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function calendarId(b: Record<string, unknown>, out: Record<string, unknown>): string | null {
  if (absent(b.calendar_id)) return null;
  const id = b.calendar_id;
  if (typeof id !== 'string' || !CALENDAR_ID_RE.test(id) || !/[A-Za-z0-9]/.test(id)) {
    return `calendar_id must be primary or a calendar id from google_calendar_list_calendars (1 to ${CALENDAR_MAX_ID_CHARS} letters, digits or . _ @ # -)`;
  }
  out.calendar_id = id;
  return null;
}

function listEvents(b: Record<string, unknown>, out: Record<string, unknown>, now: number): string | null {
  const min = absent(b.time_min) ? null : zonedDateTimeMs(b.time_min);
  if (!absent(b.time_min) && min === null) return `time_min ${DATE_TIME_HINT}`;
  const max = absent(b.time_max) ? null : zonedDateTimeMs(b.time_max);
  if (!absent(b.time_max) && max === null) return `time_max ${DATE_TIME_HINT}`;
  const start = min ?? now;
  const end = max ?? start + CALENDAR_DEFAULT_RANGE_DAYS * DAY_MS;
  const defaulted = min === null ? ' (time_min defaults to now)' : '';
  if (end <= start) return `time_max must be later than time_min${defaulted}`;
  if (end - start > CALENDAR_MAX_RANGE_DAYS * DAY_MS) return `time_min to time_max must be at most ${CALENDAR_MAX_RANGE_DAYS} days${defaulted}`;
  out.time_min = new Date(start).toISOString();
  out.time_max = new Date(end).toISOString();
  const error = calendarId(b, out);
  if (error) return error;
  if (!absent(b.max_results)) {
    const n = wholeNumber(b.max_results, 1, CALENDAR_MAX_RESULTS);
    if (n === null) return `max_results must be a whole number from 1 to ${CALENDAR_MAX_RESULTS}`;
    out.max_results = n;
  }
  if (!absent(b.query)) {
    const q = b.query;
    if (typeof q !== 'string' || q.trim() === '' || q.length > CALENDAR_MAX_QUERY_CHARS || UNSAFE_TEXT_RE.test(q)) {
      return `query must be text of 1 to ${CALENDAR_MAX_QUERY_CHARS} characters on one line, without control or invisible characters`;
    }
    out.query = q.trim();
  }
  return null;
}

/**
 * The arguments of one tool: known names only, every value checked. On success `args` holds only the checked values (dates in UTC, the
 * list range filled in); that object, and nothing else, is what reaches Emma's tool. `now` is for tests.
 */
export function checkGoogleCalendarReadArgs(tool: GoogleCalendarReadTool, args: unknown, now: number = Date.now()): CalendarArgCheck {
  if (absent(args)) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: 'the arguments must be an object' };
  const b = args as Record<string, unknown>;
  const inputs = GOOGLE_CALENDAR_READ_INPUTS[tool];
  const unknown = Object.keys(b).filter((key) => !inputs.includes(key));
  if (unknown.length > 0) {
    const names = unknown.map((k) => `"${k.slice(0, 40)}"`).join(', ');
    const takes = inputs.length > 0 ? `The inputs are: ${inputs.join(', ')}` : `${tool} takes no arguments`;
    return { ok: false, error: `${names} ${unknown.length > 1 ? 'are not inputs' : 'is not an input'}. ${takes}` };
  }
  const out: Record<string, unknown> = {};
  let error: string | null = null;
  switch (tool) {
    case 'google_calendar_list_events':
      error = listEvents(b, out, now);
      break;
    case 'google_calendar_get_event':
      if (typeof b.event_id !== 'string' || !CALENDAR_EVENT_ID_RE.test(b.event_id)) {
        error = `event_id is required and must be an event id from google_calendar_list_events (1 to ${CALENDAR_MAX_EVENT_ID_CHARS} letters, digits or _)`;
        break;
      }
      out.event_id = b.event_id;
      error = calendarId(b, out);
      break;
    case 'google_calendar_list_calendars':
      break;
    default:
      error = 'unknown tool';
  }
  return error ? { ok: false, error } : { ok: true, args: out };
}

/** The route's body `{ tool, args }`: nothing else at the top level, a known tool, its arguments checked as above. */
export function checkGoogleCalendarReadBody(body: unknown, now: number = Date.now()): CalendarBodyCheck {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'the body must be an object { tool, args }' };
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((key) => key !== 'tool' && key !== 'args');
  if (unknown.length > 0) {
    return { ok: false, error: `${unknown.map((k) => `"${k.slice(0, 40)}"`).join(', ')} ${unknown.length > 1 ? 'are not inputs' : 'is not an input'}. The body is { tool, args }` };
  }
  const tool = b.tool;
  if (typeof tool !== 'string' || !(GOOGLE_CALENDAR_READ_TOOLS as readonly string[]).includes(tool)) {
    return { ok: false, error: `tool must be one of ${GOOGLE_CALENDAR_READ_TOOLS.join(', ')}` };
  }
  const checked = checkGoogleCalendarReadArgs(tool as GoogleCalendarReadTool, b.args, now);
  return checked.ok ? { ok: true, tool: tool as GoogleCalendarReadTool, args: checked.args } : checked;
}
