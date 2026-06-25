/**
 * Tests for google_calendar_create_event.
 *
 * Verifies the booking capability added to close the calendar capability gap:
 * read-only connections are told to reconnect, timed/all-day events build the
 * correct Google Calendar request body, attendees/conference are wired, and
 * API errors map to actionable messages.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockInsert = jest.fn();

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
      events: { insert: (...args: any[]) => mockInsert(...args) },
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

const run = (args: any, context: any = CONTEXT) =>
  emmaToolRegistry.getTool('google_calendar_create_event')!.execute(args, context);

beforeEach(() => {
  mockInsert.mockReset();
  mockGetAccountByPlatform.mockReset();
});

describe('google_calendar_create_event registration', () => {
  it('is registered with required summary and start', () => {
    const tool = emmaToolRegistry.getTool('google_calendar_create_event');
    expect(tool).toBeDefined();
    expect(tool!.definition.inputSchema.required).toEqual(['summary', 'start']);
  });
});

describe('google_calendar_create_event guards', () => {
  it('requires user context', async () => {
    const res = await run({ summary: 'x', start: '2026-06-30T10:00:00' }, {});
    expect(res.success).toBe(false);
    expect(mockGetAccountByPlatform).not.toHaveBeenCalled();
  });

  it('requires summary', async () => {
    const res = await run({ start: '2026-06-30T10:00:00' });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/summary/i);
  });

  it('requires start', async () => {
    const res = await run({ summary: 'Meeting' });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/start/i);
  });

  it('returns a connect message when no Gmail account exists', async () => {
    mockGetAccountByPlatform.mockResolvedValue(null);
    const res = await run({ summary: 'Meeting', start: '2026-06-30T10:00:00' });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/connect your Gmail/i);
  });

  it('asks to reconnect when the connection is read-only', async () => {
    mockGetAccountByPlatform.mockResolvedValue(writeAccount([GOOGLE_CALENDAR_READONLY_SCOPE]));
    const res = await run({ summary: 'Meeting', start: '2026-06-30T10:00:00' });
    expect(res.success).toBe(false);
    expect(res.needs_reconnect).toBe(true);
    expect(res.message).toMatch(/write access/i);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe('google_calendar_create_event success paths', () => {
  it('creates a timed event with a default 30-minute end and timezone', async () => {
    mockGetAccountByPlatform.mockResolvedValue(writeAccount());
    mockInsert.mockResolvedValue({
      data: {
        id: 'evt1',
        summary: 'Strategy sync',
        start: { dateTime: '2026-06-30T14:00:00', timeZone: 'America/Los_Angeles' },
        end: { dateTime: '2026-06-30T14:30:00', timeZone: 'America/Los_Angeles' },
        htmlLink: 'https://cal/evt1',
      },
    });

    const res = await run({
      summary: 'Strategy sync',
      start: '2026-06-30T14:00:00',
      time_zone: 'America/Los_Angeles',
    });

    expect(res.success).toBe(true);
    const body = mockInsert.mock.calls[0][0].requestBody;
    expect(body.start).toEqual({ dateTime: '2026-06-30T14:00:00', timeZone: 'America/Los_Angeles' });
    expect(body.end).toEqual({ dateTime: '2026-06-30T14:30:00', timeZone: 'America/Los_Angeles' });
    expect(res.event.html_link).toBe('https://cal/evt1');
  });

  it('uses the supplied end when given', async () => {
    mockGetAccountByPlatform.mockResolvedValue(writeAccount());
    mockInsert.mockResolvedValue({ data: { id: 'e', summary: 's', start: {}, end: {} } });

    await run({
      summary: 's',
      start: '2026-06-30T09:00:00',
      end: '2026-06-30T11:00:00',
      time_zone: 'UTC',
    });

    const body = mockInsert.mock.calls[0][0].requestBody;
    expect(body.end.dateTime).toBe('2026-06-30T11:00:00');
  });

  it('creates an all-day event with an exclusive next-day end', async () => {
    mockGetAccountByPlatform.mockResolvedValue(writeAccount());
    mockInsert.mockResolvedValue({ data: { id: 'e', summary: 'Holiday', start: { date: '2026-07-01' }, end: { date: '2026-07-02' } } });

    const res = await run({ summary: 'Holiday', start: '2026-07-01' });

    const body = mockInsert.mock.calls[0][0].requestBody;
    expect(body.start).toEqual({ date: '2026-07-01' });
    expect(body.end).toEqual({ date: '2026-07-02' });
    expect(res.success).toBe(true);
  });

  it('rejects all-day start combined with a datetime end', async () => {
    mockGetAccountByPlatform.mockResolvedValue(writeAccount());
    const res = await run({ summary: 's', start: '2026-07-01', end: '2026-07-01T10:00:00' });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/all-day/i);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('returns error when start datetime is malformed and end is omitted', async () => {
    mockGetAccountByPlatform.mockResolvedValue(writeAccount());
    // "2026-06-30T14" has no minutes — addMinutesToDateTime returns null → error path
    const res = await run({ summary: 's', start: '2026-06-30T14' });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/end time/i);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('wires attendees and requests email updates', async () => {
    mockGetAccountByPlatform.mockResolvedValue(writeAccount());
    mockInsert.mockResolvedValue({ data: { id: 'e', summary: 's', start: {}, end: {}, attendees: [] } });

    await run({
      summary: 's',
      start: '2026-06-30T10:00:00',
      attendees: ['a@x.com', 'not-an-email', 'b@y.com'],
    });

    const call = mockInsert.mock.calls[0][0];
    expect(call.requestBody.attendees).toEqual([{ email: 'a@x.com' }, { email: 'b@y.com' }]);
    expect(call.sendUpdates).toBe('all');
  });

  it('attaches a Google Meet conference when requested', async () => {
    mockGetAccountByPlatform.mockResolvedValue(writeAccount());
    mockInsert.mockResolvedValue({ data: { id: 'e', summary: 's', start: {}, end: {}, hangoutLink: 'https://meet/x' } });

    const res = await run({ summary: 's', start: '2026-06-30T10:00:00', add_conference: true });

    const call = mockInsert.mock.calls[0][0];
    expect(call.conferenceDataVersion).toBe(1);
    expect(call.requestBody.conferenceData.createRequest.conferenceSolutionKey.type).toBe('hangoutsMeet');
    expect(res.event.meeting_link).toBe('https://meet/x');
  });

  it('does not attach conference when add_conference is false', async () => {
    mockGetAccountByPlatform.mockResolvedValue(writeAccount());
    mockInsert.mockResolvedValue({ data: { id: 'e', summary: 's', start: {}, end: {} } });

    await run({ summary: 's', start: '2026-06-30T10:00:00', add_conference: false });

    const call = mockInsert.mock.calls[0][0];
    expect(call.requestBody.conferenceData).toBeUndefined();
    expect(call.conferenceDataVersion).toBeUndefined();
  });
});

describe('sanitizeField truncation', () => {
  beforeEach(() => {
    mockGetAccountByPlatform.mockResolvedValue(writeAccount());
  });

  it('truncates event title >200 chars in response', async () => {
    const longTitle = 'A'.repeat(250);
    mockInsert.mockResolvedValue({ data: { id: 'e', summary: longTitle, start: {}, end: {} } });

    const res = await run({ summary: 's', start: '2026-06-30T10:00:00' });
    expect(res.event.title).toBe('A'.repeat(200) + '…');
  });

  it('truncates title >100 chars in success message', async () => {
    const longTitle = 'B'.repeat(150);
    mockInsert.mockResolvedValue({ data: { id: 'e', summary: longTitle, start: {}, end: {} } });

    const res = await run({ summary: 's', start: '2026-06-30T10:00:00' });
    expect(res.message).toContain('B'.repeat(100) + '…');
  });

  it('does not truncate title under the limit', async () => {
    mockInsert.mockResolvedValue({ data: { id: 'e', summary: 'Short title', start: {}, end: {} } });

    const res = await run({ summary: 's', start: '2026-06-30T10:00:00' });
    expect(res.event.title).toBe('Short title');
  });

  it('truncates location >200 chars', async () => {
    const longLocation = 'L'.repeat(250);
    mockInsert.mockResolvedValue({ data: { id: 'e', summary: 's', start: {}, end: {}, location: longLocation } });

    const res = await run({ summary: 's', start: '2026-06-30T10:00:00' });
    expect(res.event.location).toBe('L'.repeat(200) + '…');
  });
});

describe('google_calendar_create_event error mapping', () => {
  it('maps a 403 to a reconnect message', async () => {
    mockGetAccountByPlatform.mockResolvedValue(writeAccount());
    mockInsert.mockRejectedValue({ response: { status: 403 }, message: 'forbidden' });

    const res = await run({ summary: 's', start: '2026-06-30T10:00:00' });
    expect(res.success).toBe(false);
    expect(res.needs_reconnect).toBe(true);
  });

  it('maps a 400 to a date/time format hint', async () => {
    mockGetAccountByPlatform.mockResolvedValue(writeAccount());
    mockInsert.mockRejectedValue({ response: { status: 400 }, message: 'bad time' });

    const res = await run({ summary: 's', start: '2026-06-30T10:00:00' });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/date\/time/i);
  });

  it('returns a generic failure for other errors', async () => {
    mockGetAccountByPlatform.mockResolvedValue(writeAccount());
    mockInsert.mockRejectedValue({ message: 'boom' });

    const res = await run({ summary: 's', start: '2026-06-30T10:00:00' });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/Failed to create/i);
  });
});
