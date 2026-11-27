/**
 * ENG-2840 (W2-10): `POST /api/emma/google-calendar-read`, the route behind the three MCP Google Calendar reads
 * (`google_calendar_list_events`, `google_calendar_get_event`, `google_calendar_list_calendars`, mcp/server/googleCalendarReadTools.ts).
 *
 * Body `{ tool, args }`. Mounted on the /api/emma router (authenticated, metered); any portal token can reach it directly, so it does not
 * trust its caller: the body is checked again with the same rules as the tools (utils/googleCalendarReadArgs.ts) and Emma's own tool runs
 * through Emma's own registry, exactly as her dispatcher runs it, with `{ userId }` as the only context, `userId` being `req.user.userId`.
 * No identity is ever read from the body (a `userId` there is refused by name). Emma's calendar tools read the caller's OWN connected Gmail
 * account (`getAccountByPlatform(userId, 'gmail')`): no organization sharing, no service account; Google's own ACL decides which calendars
 * that account can read. The registry adds its own checks for that user (an evaluation sandbox's policy, an anonymous account).
 *
 * Answers:
 *  - `{ success: true, ... }` with Emma's top-level fields only (list_events: calendar_id, time_min, time_max, count, events; get_event:
 *    event; list_calendars: count, calendars).
 *  - `{ success: false, reason, message }` (HTTP 200) when Emma refused or Google answered an error: a fixed text chosen here from Emma's
 *    fixed refusals (no Gmail connected, no calendar scope) or Google's HTTP status. Emma's own message carries Google's raw error text
 *    (`Failed to fetch ...: <error.message>`) and echoes the ids; it is never passed on.
 *  - HTTP 400 for a bad body, 401 without a user, 403 in an evaluation sandbox, 500 with a fixed text on anything unexpected.
 * A share-link visitor is not refused: Emma lets a visitor run these reads too.
 */
import type { Router, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { EvaluationDenied } from '../services/evaluationPolicy';
import { checkGoogleCalendarReadBody, type GoogleCalendarReadTool } from '../utils/googleCalendarReadArgs';

const SETTINGS = 'Settings > Connected Accounts';

/** The fixed refusal texts (no final full stop: the MCP tools add one). */
export const CALENDAR_REFUSALS = {
  not_connected: `Google Calendar is not connected: no Gmail account is connected to your AgentWeb account. Connect Gmail with Calendar access in ${SETTINGS}. Nothing was changed`,
  no_calendar_scope: `The connected Gmail account has not granted Calendar access. Reconnect Gmail in ${SETTINGS} and allow Calendar access. Nothing was changed`,
  google_sign_in: `Google did not accept the connected account's sign-in (HTTP 401). Reconnect Gmail in ${SETTINGS}. Nothing was changed`,
  google_forbidden: 'Google refused access (HTTP 403): the calendar is not shared with the connected account, Calendar access needs reconnecting, or Google\'s usage limit was reached. Nothing was changed',
  not_found: 'Google found no such calendar or event for the connected account (HTTP 404). Use ids from google_calendar_list_calendars or google_calendar_list_events. Nothing was changed',
  google_rate_limited: 'Google\'s rate limit for the connected account was reached (HTTP 429). Try again in a minute. Nothing was changed',
  google_refused: 'Google refused the request (HTTP {status}). Check the arguments. Nothing was changed',
  google_unavailable: 'Google Calendar could not answer (HTTP {status}). Try again later. Nothing was changed',
  failed: 'Google Calendar could not be read. Try again later. Nothing was changed',
} as const;
export type CalendarRefusalReason = keyof typeof CALENDAR_REFUSALS;

const FAILED_TEXT = 'The Google Calendar read failed. Try again later.';
const SANDBOX_TEXT = 'This tool is not available in this sandbox workspace';

/** Emma's `status`: Google's HTTP status (a number), or a network error code (text), or nothing. */
function httpStatus(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^[1-5][0-9]{2}$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 100 && n <= 599 ? n : null;
}

/**
 * The fixed refusal for an Emma answer that is not a success. Emma's two fixed refusals are matched on her own words; everything else on
 * Google's HTTP status only. Exported for tests.
 */
export function calendarRefusal(result: Record<string, unknown>): { reason: CalendarRefusalReason; message: string } {
  const said = typeof result.message === 'string' ? result.message : '';
  const fixed = (reason: CalendarRefusalReason, status?: number) => ({ reason, message: CALENDAR_REFUSALS[reason].replace('{status}', String(status)) });
  if (/^No Gmail account connected\b/.test(said)) return fixed('not_connected');
  if (/^Google Calendar access not granted\b/.test(said)) return fixed('no_calendar_scope');
  const status = httpStatus(result.status);
  if (status === 401) return fixed('google_sign_in');
  if (status === 403) return fixed('google_forbidden');
  if (status === 404 || status === 410) return fixed('not_found');
  if (status === 429) return fixed('google_rate_limited');
  if (status !== null && status >= 400 && status < 500) return fixed('google_refused', status);
  if (status !== null && status >= 500) return fixed('google_unavailable', status);
  return fixed('failed');
}

/** Emma's top-level answer fields per tool: nothing else leaves. */
const ANSWER_KEYS: Record<GoogleCalendarReadTool, readonly string[]> = {
  google_calendar_list_events: ['calendar_id', 'time_min', 'time_max', 'count', 'events'],
  google_calendar_get_event: ['event'],
  google_calendar_list_calendars: ['count', 'calendars'],
};

function answer(tool: GoogleCalendarReadTool, result: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { success: true };
  for (const key of ANSWER_KEYS[tool]) if (result[key] !== undefined) out[key] = result[key];
  return out;
}

/** Emma's own tool through Emma's own registry, as her dispatcher runs it, for this user only. */
async function runEmmaTool(name: GoogleCalendarReadTool, args: Record<string, unknown>, caller: string): Promise<unknown> {
  await import('../emma/calendarTools');
  const { emmaToolRegistry } = await import('../emma/registry');
  return emmaToolRegistry.execute(name, args, { userId: caller });
}

/** Registers `POST /google-calendar-read` on the emmaApi router (after its authentication and token-budget middleware). */
export function registerGoogleCalendarRoutes(router: Router): void {
  router.post('/google-calendar-read', async (req: Request, res: Response) => {
    const caller = (req as AuthenticatedRequest).user?.userId;
    if (typeof caller !== 'string' || caller === '') return res.status(401).json({ message: 'Authentication required' });
    const checked = checkGoogleCalendarReadBody(req.body);
    if (!checked.ok) return res.status(400).json({ message: checked.error });
    try {
      const result = await runEmmaTool(checked.tool, checked.args, caller);
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        console.error(`[emma] /google-calendar-read ${checked.tool}: no answer from Emma's tool`);
        return res.status(500).json({ message: FAILED_TEXT });
      }
      const r = result as Record<string, unknown>;
      if (r.success !== true) {
        const refusal = calendarRefusal(r);
        console.warn(`[emma] /google-calendar-read ${checked.tool} refused: ${refusal.reason} (status ${String(httpStatus(r.status) ?? 'none')})`);
        return res.json({ success: false, reason: refusal.reason, message: refusal.message });
      }
      return res.json(answer(checked.tool, r));
    } catch (err: any) {
      if (err instanceof EvaluationDenied) return res.status(403).json({ message: SANDBOX_TEXT });
      console.error(`[emma] /google-calendar-read ${checked.tool} failed:`, err?.message);
      return res.status(500).json({ message: FAILED_TEXT });
    }
  });
}
