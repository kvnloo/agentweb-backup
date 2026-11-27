/**
 * ENG-2840 (W2-10): `POST /api/emma/google-calendar-read` (routes/emmaGoogleCalendarRoutes.ts), the route behind the MCP Google Calendar
 * reads. It runs Emma's own tool through Emma's registry with `{ userId: req.user.userId }` as the only context, after checking the body
 * `{ tool, args }` by name and value; Emma's refusals and Google's errors become fixed texts (Google's raw message never leaves); only
 * Emma's top-level answer fields leave. The router here stands in for emmaApi's (its auth and budget middleware have their own tests): a fake
 * user is set on every request unless a test removes it.
 */
import express, { Router } from 'express';
import request from 'supertest';

const mockExecute = jest.fn();
jest.mock('../emma/registry', () => ({ emmaToolRegistry: { execute: (...args: unknown[]) => mockExecute(...args) } }));
jest.mock('../emma/calendarTools', () => ({}));

import { registerGoogleCalendarRoutes, CALENDAR_REFUSALS, calendarRefusal } from '../routes/emmaGoogleCalendarRoutes';
import { EvaluationDenied } from '../services/evaluationPolicy';

let requestExtras: Record<string, unknown> = {};
let withUser = true;
const router = Router();
router.use((req: any, _res: any, next: any) => {
  if (withUser) req.user = { userId: 'caller-1', email: 'caller@example.com', isAdmin: true };
  Object.assign(req, requestExtras);
  next();
});
registerGoogleCalendarRoutes(router);
const app = express();
app.use(express.json());
app.use('/api/emma', router);

const post = (body: unknown) => request(app).post('/api/emma/google-calendar-read').send(body as any);
const RANGE = { time_min: '2026-11-01T00:00:00Z', time_max: '2026-11-08T00:00:00Z' };

beforeEach(() => {
  mockExecute.mockReset();
  requestExtras = {};
  withUser = true;
});

describe('identity: req.user.userId only', () => {
  it('runs Emma\'s tool with { userId } and nothing else, whatever else the request carries', async () => {
    requestExtras = { delegateInfo: { adminUserId: 'admin-9', isDelegated: true }, isSelfCall: true, restrictionProfile: 'share_visitor' };
    mockExecute.mockResolvedValue({ success: true, calendars: [] });
    const res = await post({ tool: 'google_calendar_list_calendars', args: {} });
    expect(res.status).toBe(200);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [name, args, context] = mockExecute.mock.calls[0];
    expect(name).toBe('google_calendar_list_calendars');
    expect(args).toStrictEqual({});
    expect(context).toStrictEqual({ userId: 'caller-1' });
  });

  it('refuses any identity field in the body or in args by name (400), calling nothing', async () => {
    for (const body of [
      { tool: 'google_calendar_list_events', args: {}, userId: 'victim' },
      { tool: 'google_calendar_list_events', args: { userId: 'victim' } },
      { tool: 'google_calendar_get_event', args: { event_id: 'abc', user_id: 'victim' } },
      { tool: 'google_calendar_list_calendars', args: { owner_user_id: 'victim' } },
      { tool: 'google_calendar_list_calendars', context: { userId: 'victim' } },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/is not an input/);
    }
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('401 without a signed-in user, calling nothing', async () => {
    withUser = false;
    const res = await post({ tool: 'google_calendar_list_calendars' });
    expect(res.status).toBe(401);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('each tool runs with only the checked values (dates in UTC, the range filled in, the query trimmed)', async () => {
    mockExecute.mockResolvedValue({ success: true });
    await post({ tool: 'google_calendar_list_events', args: { time_min: '2026-11-01T09:00:00+05:30', time_max: '2026-11-02T00:00:00Z', calendar_id: 'team@group.calendar.google.com', max_results: 10, query: ' sync ' } });
    await post({ tool: 'google_calendar_list_events', args: { time_min: '2026-11-01T00:00:00Z' } });
    await post({ tool: 'google_calendar_get_event', args: { event_id: 'abc_20261127T100000Z' } });
    await post({ tool: 'google_calendar_list_calendars' });
    expect(mockExecute.mock.calls.map((c) => [c[0], c[1], c[2]])).toStrictEqual([
      ['google_calendar_list_events', { time_min: '2026-11-01T03:30:00.000Z', time_max: '2026-11-02T00:00:00.000Z', calendar_id: 'team@group.calendar.google.com', max_results: 10, query: 'sync' }, { userId: 'caller-1' }],
      ['google_calendar_list_events', { time_min: '2026-11-01T00:00:00.000Z', time_max: '2026-11-08T00:00:00.000Z' }, { userId: 'caller-1' }],
      ['google_calendar_get_event', { event_id: 'abc_20261127T100000Z' }, { userId: 'caller-1' }],
      ['google_calendar_list_calendars', {}, { userId: 'caller-1' }],
    ]);
  });
});

describe('bad input is refused (400) before anything runs', () => {
  it.each<[unknown, RegExp]>([
    [[1, 2], /the body must be an object/],
    [{}, /tool must be one of google_calendar_list_events, google_calendar_get_event, google_calendar_list_calendars/],
    [{ tool: 'google_calendar_create_event', args: { title: 'x' } }, /tool must be one of/],
    [{ tool: 'google_calendar_delete_event', args: { event_id: 'abc' } }, /tool must be one of/],
    [{ tool: 'google_calendar_list_events', args: 'x' }, /the arguments must be an object/],
    [{ tool: 'google_calendar_list_events', args: { time_min: '2026-11-01' } }, /time_min must be an ISO 8601 date-time with a zone/],
    [{ tool: 'google_calendar_list_events', args: { time_min: '2026-11-01T00:00:00Z', time_max: '2027-02-02T00:00:00Z' } }, /at most 92 days/],
    [{ tool: 'google_calendar_list_events', args: { ...RANGE, max_results: 250 } }, /max_results must be a whole number from 1 to 100/],
    [{ tool: 'google_calendar_list_events', args: { ...RANGE, max_results: -1 } }, /max_results/],
    [{ tool: 'google_calendar_list_events', args: { ...RANGE, query: 'q'.repeat(201) } }, /query must be text/],
    [{ tool: 'google_calendar_list_events', args: { ...RANGE, calendar_id: '..' } }, /calendar_id must be primary or a calendar id/],
    [{ tool: 'google_calendar_list_events', args: { ...RANGE, calendar_id: 'a/../b' } }, /calendar_id must be/],
    [{ tool: 'google_calendar_get_event', args: {} }, /event_id is required/],
    [{ tool: 'google_calendar_get_event', args: { event_id: '../calendarList' } }, /event_id is required and must be an event id/],
    [{ tool: 'google_calendar_list_calendars', args: { max_results: 5 } }, /"max_results" is not an input\. google_calendar_list_calendars takes no arguments/],
  ])('%j', async (body, re) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(re);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe('answers', () => {
  it('passes on only Emma\'s top-level answer fields per tool', async () => {
    mockExecute.mockResolvedValueOnce({ success: true, calendar_id: 'primary', time_min: 'a', time_max: 'b', count: 0, events: [], debug: 'x', token: 'secret' });
    expect((await post({ tool: 'google_calendar_list_events', args: RANGE })).body).toStrictEqual({ success: true, calendar_id: 'primary', time_min: 'a', time_max: 'b', count: 0, events: [] });
    mockExecute.mockResolvedValueOnce({ success: true, event: { id: 'e1' }, raw: { conferenceId: 'c' } });
    expect((await post({ tool: 'google_calendar_get_event', args: { event_id: 'e1' } })).body).toStrictEqual({ success: true, event: { id: 'e1' } });
    mockExecute.mockResolvedValueOnce({ success: true, count: 1, calendars: [{ id: 'c1' }], nextPageToken: 'p' });
    expect((await post({ tool: 'google_calendar_list_calendars' })).body).toStrictEqual({ success: true, count: 1, calendars: [{ id: 'c1' }] });
  });
});

describe('refusals and errors: fixed texts only, Google\'s raw message never leaves', () => {
  const RAW = 'invalid_grant: Token has been expired or revoked. request id 7f3a-SECRET for https://www.googleapis.com/calendar/v3/calendars/x';

  it.each<[string, Record<string, unknown>, keyof typeof CALENDAR_REFUSALS, string]>([
    ['no Gmail connected', { success: false, message: 'No Gmail account connected. Please connect your Gmail account in Settings → Connected Accounts to use Google Calendar.' }, 'not_connected', ''],
    ['no calendar scope', { success: false, message: 'Google Calendar access not granted. Please reconnect your Gmail account and allow Calendar access in Settings → Connected Accounts.' }, 'no_calendar_scope', ''],
    ['401', { success: false, message: 'Calendar access denied. Please reconnect your Gmail account with Calendar access in Settings → Connected Accounts.', status: 401 }, 'google_sign_in', ''],
    ['403', { success: false, message: `Failed to fetch event: ${RAW}`, status: 403 }, 'google_forbidden', ''],
    ['404 (Emma echoes the ids)', { success: false, message: 'Event abc123 not found in calendar victim@example.com.', status: 404 }, 'not_found', ''],
    ['404 as text', { success: false, message: `Failed to fetch calendars: ${RAW}`, status: '404' }, 'not_found', ''],
    ['410', { success: false, message: RAW, status: 410 }, 'not_found', ''],
    ['429', { success: false, message: `Failed to fetch calendar events: ${RAW}`, status: 429 }, 'google_rate_limited', ''],
    ['400', { success: false, message: `Failed to fetch calendar events: ${RAW}`, status: 400 }, 'google_refused', 'HTTP 400'],
    ['503', { success: false, message: `Failed to fetch calendars: ${RAW}`, status: 503 }, 'google_unavailable', 'HTTP 503'],
    ['a network error code', { success: false, message: `Failed to fetch calendar events: connect ECONNRESET 10.0.0.5 ${RAW}`, status: 'ECONNRESET' }, 'failed', ''],
    ['no status', { success: false, message: `Failed to fetch event: ${RAW}` }, 'failed', ''],
    ['no user context', { success: false, message: 'Authentication required: no user context.' }, 'failed', ''],
    ['a not-connected text later in a raw message', { success: false, message: `Failed: ${RAW} No Gmail account connected`, status: 500 }, 'google_unavailable', 'HTTP 500'],
  ])('%s', async (_label, result, reason, statusText) => {
    mockExecute.mockResolvedValueOnce(result);
    const res = await post({ tool: 'google_calendar_list_events', args: RANGE });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.reason).toBe(reason);
    expect(Object.keys(res.body).sort()).toEqual(['message', 'reason', 'success']);
    expect(res.body.message).toMatch(/Nothing was changed$/);
    if (statusText) expect(res.body.message).toContain(statusText);
    else expect(res.body.message).toBe(CALENDAR_REFUSALS[reason]);
    expect(JSON.stringify(res.body)).not.toMatch(/invalid_grant|SECRET|googleapis|ECONNRESET|10\.0\.0\.5|abc123|victim/);
  });

  it('calendarRefusal never returns the input text', () => {
    for (const status of [undefined, 400, 401, 403, 404, 429, 500, 'x']) {
      expect(calendarRefusal({ success: false, message: RAW, status }).message).not.toMatch(/invalid_grant|SECRET/);
    }
  });

  it('an unexpected failure is a 500 with a fixed text, never the exception\'s own words', async () => {
    mockExecute.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:8000 secret-detail'));
    const res = await post({ tool: 'google_calendar_get_event', args: { event_id: 'abc' } });
    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual({ message: 'The Google Calendar read failed. Try again later.' });
    mockExecute.mockResolvedValueOnce(undefined);
    const empty = await post({ tool: 'google_calendar_list_calendars' });
    expect(empty.status).toBe(500);
    expect(empty.body).toStrictEqual({ message: 'The Google Calendar read failed. Try again later.' });
  });

  it('an evaluation sandbox refusal from Emma\'s registry is a 403', async () => {
    mockExecute.mockRejectedValueOnce(new EvaluationDenied('Tool "google_calendar_list_events" is not available in this sandbox workspace'));
    const res = await post({ tool: 'google_calendar_list_events', args: RANGE });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/sandbox workspace/);
  });
});
