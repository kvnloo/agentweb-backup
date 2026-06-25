/**
 * Tests for google_calendar_update_event and google_calendar_delete_event.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockPatch = jest.fn();
const mockDelete = jest.fn();

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
      events: {
        patch: (...args: any[]) => mockPatch(...args),
        delete: (...args: any[]) => mockDelete(...args),
        insert: jest.fn(),
        list: jest.fn(),
        get: jest.fn(),
      },
      calendarList: { list: jest.fn() },
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
import {
  GOOGLE_CALENDAR_EVENTS_SCOPE,
  GOOGLE_CALENDAR_READONLY_SCOPE,
} from '../services/connectedAccountsDb';

const CONTEXT = { userId: 'user-1' };

const writeAccount = (scopes: string[] = [GOOGLE_CALENDAR_EVENTS_SCOPE]) => ({
  account_id: 'user@example.com',
  config: {
    account_type: 'gmail',
    email: 'user@example.com',
    access_token: 'tok',
    refresh_token: 'refresh',
    token_expires_at: Date.now() + 3600_000,
    granted_scopes: scopes,
    scopes,
  },
});

const readOnlyAccount = () => writeAccount([GOOGLE_CALENDAR_READONLY_SCOPE]);

const runUpdate = (args: any, context: any = CONTEXT) =>
  emmaToolRegistry.getTool('google_calendar_update_event')!.execute(args, context);

const runDelete = (args: any, context: any = CONTEXT) =>
  emmaToolRegistry.getTool('google_calendar_delete_event')!.execute(args, context);

beforeEach(() => {
  mockPatch.mockReset();
  mockDelete.mockReset();
  mockGetAccountByPlatform.mockReset();
});

// ── Registration ─────────────────────────────────────────────────────────────

describe('tool registration', () => {
  it('google_calendar_update_event is registered with event_id required', () => {
    const tool = emmaToolRegistry.getTool('google_calendar_update_event');
    expect(tool).toBeDefined();
    expect(tool!.definition.inputSchema.required).toEqual(['event_id']);
  });

  it('google_calendar_delete_event is registered with event_id required', () => {
    const tool = emmaToolRegistry.getTool('google_calendar_delete_event');
    expect(tool).toBeDefined();
    expect(tool!.definition.inputSchema.required).toEqual(['event_id']);
  });
});

// ── google_calendar_update_event guards ──────────────────────────────────────

describe('google_calendar_update_event guards', () => {
  it('requires user context', async () => {
    const res = await runUpdate({ event_id: 'ev1', summary: 'x' }, {});
    expect(res.success).toBe(false);
    expect(mockGetAccountByPlatform).not.toHaveBeenCalled();
  });

  it('requires event_id', async () => {
    const res = await runUpdate({ summary: 'x' });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/event_id/i);
  });

  it('returns no-account message when Gmail not connected', async () => {
    mockGetAccountByPlatform.mockResolvedValue(null);
    const res = await runUpdate({ event_id: 'ev1', summary: 'x' });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/no gmail account/i);
  });

  it('returns needs_reconnect when only read-only scope', async () => {
    mockGetAccountByPlatform.mockResolvedValue(readOnlyAccount());
    const res = await runUpdate({ event_id: 'ev1', summary: 'x' });
    expect(res.success).toBe(false);
    expect(res.needs_reconnect).toBe(true);
  });

  it('returns error when no fields provided', async () => {
    mockGetAccountByPlatform.mockResolvedValue(writeAccount());
    const res = await runUpdate({ event_id: 'ev1' });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/no fields to update/i);
    expect(mockPatch).not.toHaveBeenCalled();
  });
});

// ── google_calendar_update_event happy paths ──────────────────────────────────

describe('google_calendar_update_event happy paths', () => {
  const mockEvent = {
    id: 'ev1',
    summary: 'Updated title',
    start: { dateTime: '2026-06-30T14:00:00+05:30' },
    end: { dateTime: '2026-06-30T14:50:00+05:30' },
    location: null,
    hangoutLink: null,
    htmlLink: 'https://calendar.google.com/event?eid=ev1',
  };

  beforeEach(() => {
    mockGetAccountByPlatform.mockResolvedValue(writeAccount());
    mockPatch.mockResolvedValue({ data: mockEvent });
  });

  it('updates summary only — patch body has only summary', async () => {
    const res = await runUpdate({ event_id: 'ev1', summary: 'Updated title' });
    expect(res.success).toBe(true);
    expect(mockPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'ev1',
        calendarId: 'primary',
        requestBody: { summary: 'Updated title' },
      }),
    );
  });

  it('updates timed start/end with time_zone', async () => {
    mockPatch.mockResolvedValue({ data: { ...mockEvent, summary: 'Test' } });
    const res = await runUpdate({
      event_id: 'ev1',
      start: '2026-06-30T14:00:00',
      end: '2026-06-30T14:50:00',
      time_zone: 'Asia/Kolkata',
    });
    expect(res.success).toBe(true);
    const call = mockPatch.mock.calls[0][0];
    expect(call.requestBody.start).toEqual({ dateTime: '2026-06-30T14:00:00', timeZone: 'Asia/Kolkata' });
    expect(call.requestBody.end).toEqual({ dateTime: '2026-06-30T14:50:00', timeZone: 'Asia/Kolkata' });
  });

  it('defaults end to start+30min when end omitted', async () => {
    mockPatch.mockResolvedValue({ data: { ...mockEvent, summary: 'Test' } });
    await runUpdate({ event_id: 'ev1', start: '2026-06-30T14:00:00' });
    const call = mockPatch.mock.calls[0][0];
    expect(call.requestBody.end.dateTime).toBe('2026-06-30T14:30:00');
  });

  it('updates all-day event with exclusive end date', async () => {
    mockPatch.mockResolvedValue({ data: { ...mockEvent, start: { date: '2026-07-01' }, end: { date: '2026-07-02' } } });
    await runUpdate({ event_id: 'ev1', start: '2026-07-01' });
    const call = mockPatch.mock.calls[0][0];
    expect(call.requestBody.start).toEqual({ date: '2026-07-01' });
    expect(call.requestBody.end).toEqual({ date: '2026-07-02' });
  });

  it('replaces attendees and sends updates', async () => {
    mockPatch.mockResolvedValue({ data: { ...mockEvent, summary: 'Test' } });
    await runUpdate({ event_id: 'ev1', attendees: ['a@example.com', 'b@example.com'] });
    const call = mockPatch.mock.calls[0][0];
    expect(call.requestBody.attendees).toEqual([
      { email: 'a@example.com' },
      { email: 'b@example.com' },
    ]);
    expect(call.sendUpdates).toBe('all');
  });

  it('filters invalid attendee emails', async () => {
    mockPatch.mockResolvedValue({ data: { ...mockEvent, summary: 'Test' } });
    await runUpdate({ event_id: 'ev1', attendees: ['valid@example.com', 'notanemail', ''] });
    const call = mockPatch.mock.calls[0][0];
    expect(call.requestBody.attendees).toEqual([{ email: 'valid@example.com' }]);
  });

  it('returns event in response on success', async () => {
    const res = await runUpdate({ event_id: 'ev1', summary: 'Updated title' });
    expect(res.success).toBe(true);
    expect(res.event.id).toBe('ev1');
    expect(res.event.html_link).toBe('https://calendar.google.com/event?eid=ev1');
  });
});

// ── google_calendar_update_event error mapping ────────────────────────────────

describe('google_calendar_update_event error mapping', () => {
  beforeEach(() => {
    mockGetAccountByPlatform.mockResolvedValue(writeAccount());
  });

  it('maps 404 to not-found message', async () => {
    mockPatch.mockRejectedValue({ response: { status: 404 }, message: 'not found' });
    const res = await runUpdate({ event_id: 'ev1', summary: 'x' });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/not found/i);
  });

  it('maps 403 to needs_reconnect', async () => {
    mockPatch.mockRejectedValue({ response: { status: 403 }, message: 'forbidden' });
    const res = await runUpdate({ event_id: 'ev1', summary: 'x' });
    expect(res.success).toBe(false);
    expect(res.needs_reconnect).toBe(true);
  });

  it('maps unknown error to generic message', async () => {
    mockPatch.mockRejectedValue({ message: 'boom' });
    const res = await runUpdate({ event_id: 'ev1', summary: 'x' });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/boom/);
  });
});

// ── google_calendar_delete_event guards ──────────────────────────────────────

describe('google_calendar_delete_event guards', () => {
  it('requires user context', async () => {
    const res = await runDelete({ event_id: 'ev1' }, {});
    expect(res.success).toBe(false);
    expect(mockGetAccountByPlatform).not.toHaveBeenCalled();
  });

  it('requires event_id', async () => {
    const res = await runDelete({});
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/event_id/i);
  });

  it('returns no-account message when Gmail not connected', async () => {
    mockGetAccountByPlatform.mockResolvedValue(null);
    const res = await runDelete({ event_id: 'ev1' });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/no gmail account/i);
  });

  it('returns needs_reconnect when only read-only scope', async () => {
    mockGetAccountByPlatform.mockResolvedValue(readOnlyAccount());
    const res = await runDelete({ event_id: 'ev1' });
    expect(res.success).toBe(false);
    expect(res.needs_reconnect).toBe(true);
  });
});

// ── google_calendar_delete_event happy paths ──────────────────────────────────

describe('google_calendar_delete_event happy paths', () => {
  beforeEach(() => {
    mockGetAccountByPlatform.mockResolvedValue(writeAccount());
    mockDelete.mockResolvedValue({});
  });

  it('deletes event and returns success', async () => {
    const res = await runDelete({ event_id: 'ev1' });
    expect(res.success).toBe(true);
    expect(res.event_id).toBe('ev1');
  });

  it('passes calendarId and sendUpdates to Google API', async () => {
    await runDelete({ event_id: 'ev1', calendar_id: 'cal2', send_updates: 'none' });
    expect(mockDelete).toHaveBeenCalledWith({
      calendarId: 'cal2',
      eventId: 'ev1',
      sendUpdates: 'none',
    });
  });

  it('defaults calendarId to primary and sendUpdates to all', async () => {
    await runDelete({ event_id: 'ev1' });
    expect(mockDelete).toHaveBeenCalledWith({
      calendarId: 'primary',
      eventId: 'ev1',
      sendUpdates: 'all',
    });
  });
});

// ── google_calendar_delete_event error mapping ────────────────────────────────

describe('google_calendar_delete_event error mapping', () => {
  beforeEach(() => {
    mockGetAccountByPlatform.mockResolvedValue(writeAccount());
  });

  it('maps 404 to not-found message', async () => {
    mockDelete.mockRejectedValue({ response: { status: 404 }, message: 'not found' });
    const res = await runDelete({ event_id: 'ev1' });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/not found/i);
  });

  it('maps 410 to already-deleted message', async () => {
    mockDelete.mockRejectedValue({ response: { status: 410 }, message: 'gone' });
    const res = await runDelete({ event_id: 'ev1' });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/already deleted/i);
  });

  it('maps 403 to needs_reconnect', async () => {
    mockDelete.mockRejectedValue({ response: { status: 403 }, message: 'forbidden' });
    const res = await runDelete({ event_id: 'ev1' });
    expect(res.success).toBe(false);
    expect(res.needs_reconnect).toBe(true);
  });

  it('maps unknown error to generic message', async () => {
    mockDelete.mockRejectedValue({ message: 'boom' });
    const res = await runDelete({ event_id: 'ev1' });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/boom/);
  });
});
