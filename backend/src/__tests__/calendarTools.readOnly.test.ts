/**
 * Tests for the Google Calendar read-only tools: google_calendar_list_events,
 * google_calendar_get_event, google_calendar_list_calendars.
 *
 * ENG-1300: these three had no error-path test coverage at all — unlike
 * create/update/delete_event, which already assert on 403/404 mapping. Covers
 * both the existing friendly-message behavior and the new classification
 * chain (a clean 401/403/404 must classify as auth/not_found + config, not
 * fall back to the generic Error/bug class once toolResultError reconstructs
 * an Error from the message alone).
 */

const mockEventsList = jest.fn();
const mockEventsGet = jest.fn();
const mockCalendarListList = jest.fn();

jest.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({
        setCredentials: jest.fn(),
        refreshAccessToken: jest.fn().mockResolvedValue({
          credentials: { access_token: 'fresh', expiry_date: Date.now() + 3600_000 },
        }),
      })),
    },
    calendar: jest.fn().mockReturnValue({
      events: { list: (...args: any[]) => mockEventsList(...args), get: (...args: any[]) => mockEventsGet(...args) },
      calendarList: { list: (...args: any[]) => mockCalendarListList(...args) },
    }),
  },
}));

const mockGetAccountByPlatform = jest.fn();
jest.mock('../services/connectedAccountsDb', () => {
  const actual = jest.requireActual('../services/connectedAccountsDb');
  return {
    ...actual,
    getAccountByPlatform: (...args: any[]) => mockGetAccountByPlatform(...args),
    updateAccountTokens: jest.fn().mockResolvedValue(undefined),
  };
});

jest.mock('../config/integrations', () => ({
  getGmailConfig: jest.fn().mockResolvedValue({
    clientId: 'cid',
    clientSecret: 'secret',
    redirectUri: 'http://localhost/cb',
  }),
}));

import { emmaToolRegistry } from '../emma/registry';
import '../emma/calendarTools';
import { GOOGLE_CALENDAR_READONLY_SCOPE } from '../services/connectedAccountsDb';
import { toolResultError } from '../utils/toolResultError';
import { classifyToolErrorClass } from '../utils/toolErrorClassifier';
import { classifyToolFailureType } from '../utils/toolFailureType';

const CONTEXT = { userId: 'user-1' };

const readAccount = () => ({
  account_id: 'user@example.com',
  config: {
    account_type: 'gmail',
    email: 'user@example.com',
    access_token: 'tok',
    refresh_token: 'refresh',
    token_expires_at: Date.now() + 3600_000,
    granted_scopes: [GOOGLE_CALENDAR_READONLY_SCOPE],
    scopes: [GOOGLE_CALENDAR_READONLY_SCOPE],
  },
});

const runListEvents = (args: any = {}, context: any = CONTEXT) =>
  emmaToolRegistry.getTool('google_calendar_list_events')!.execute(args, context);
const runGetEvent = (args: any, context: any = CONTEXT) =>
  emmaToolRegistry.getTool('google_calendar_get_event')!.execute(args, context);
const runListCalendars = (args: any = {}, context: any = CONTEXT) =>
  emmaToolRegistry.getTool('google_calendar_list_calendars')!.execute(args, context);

beforeEach(() => {
  mockEventsList.mockReset();
  mockEventsGet.mockReset();
  mockCalendarListList.mockReset();
  mockGetAccountByPlatform.mockReset();
  mockGetAccountByPlatform.mockResolvedValue(readAccount());
});

describe('google_calendar_list_events error mapping', () => {
  it('maps a 403 to an access-denied message', async () => {
    mockEventsList.mockRejectedValue({ response: { status: 403 }, message: 'forbidden' });
    const res = await runListEvents();
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/access denied/i);
  });

  it('ENG-1300: a 403 classifies as auth/config end-to-end, not the generic Error/bug fallback', async () => {
    mockEventsList.mockRejectedValue({ response: { status: 403 }, message: 'forbidden' });
    const res = await runListEvents();
    const classified = toolResultError(res);
    expect(classifyToolErrorClass(classified)).toBe('auth');
    expect(classifyToolFailureType(classifyToolErrorClass(classified))).toBe('config');
  });
});

describe('google_calendar_get_event error mapping', () => {
  it('maps a 404 to a not-found message', async () => {
    mockEventsGet.mockRejectedValue({ response: { status: 404 }, message: 'not found' });
    const res = await runGetEvent({ event_id: 'ev1' });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/not found/i);
  });

  it('ENG-1300: a 404 classifies as not_found/config end-to-end, not the generic Error/bug fallback', async () => {
    mockEventsGet.mockRejectedValue({ response: { status: 404 }, message: 'not found' });
    const res = await runGetEvent({ event_id: 'ev1' });
    const classified = toolResultError(res);
    expect(classifyToolErrorClass(classified)).toBe('not_found');
    expect(classifyToolFailureType(classifyToolErrorClass(classified))).toBe('config');
  });
});

describe('google_calendar_list_calendars error mapping', () => {
  it('maps a failure to a friendly message', async () => {
    mockCalendarListList.mockRejectedValue({ response: { status: 401 }, message: 'unauthorized' });
    const res = await runListCalendars();
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/Failed to fetch calendars/i);
  });

  // ENG-1300: this function didn't even compute `status` before the fix (the
  // audit's "status available but not even computed" finding) — a plain
  // "Failed to fetch calendars: ..." message matches nothing in
  // classifyToolErrorClass, so a clean 401 fell all the way to the generic
  // Error/bug class with no signal at all.
  it('ENG-1300: a 401 classifies as auth/config end-to-end, not the generic Error/bug fallback', async () => {
    mockCalendarListList.mockRejectedValue({ response: { status: 401 }, message: 'unauthorized' });
    const res = await runListCalendars();
    const classified = toolResultError(res);
    expect(classifyToolErrorClass(classified)).toBe('auth');
    expect(classifyToolFailureType(classifyToolErrorClass(classified))).toBe('config');
  });
});

// ENG-2840 (W2-10): each Calendar read has a time limit (it had none; the MCP self-call waits 60 s).
describe('Calendar reads have a time limit', () => {
  it('passes a 30 s timeout on list_events, get_event and list_calendars', async () => {
    mockEventsList.mockResolvedValue({ data: { items: [] } });
    mockEventsGet.mockResolvedValue({ data: { id: 'e1' } });
    mockCalendarListList.mockResolvedValue({ data: { items: [] } });
    await runListEvents();
    await runGetEvent({ event_id: 'e1' });
    await runListCalendars();
    expect(mockEventsList).toHaveBeenCalledWith(expect.any(Object), { timeout: 30_000 });
    expect(mockEventsGet).toHaveBeenCalledWith(expect.any(Object), { timeout: 30_000 });
    expect(mockCalendarListList).toHaveBeenCalledWith(expect.any(Object), { timeout: 30_000 });
  });
});
