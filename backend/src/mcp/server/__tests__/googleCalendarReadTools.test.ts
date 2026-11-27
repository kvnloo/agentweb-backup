/**
 * ENG-2840 (W2-10): the three Google Calendar reads for outside agents (googleCalendarReadTools.ts). What each sends to its route, what is
 * refused before anything is called (arguments by name and by value: dates, the range, ids, sizes), the fixed-field answers and their size
 * cap (attendee lists cut first), error handling, and the per-caller guards. No network: the self-call is a double; the route has its own
 * tests (src/__tests__/emmaGoogleCalendarRoutes.test.ts).
 */
jest.mock('../httpClient', () => ({ mcpFetch: jest.fn() }));

import { mcpFetch } from '../httpClient';
import { mcpToolRegistry } from '../registry';
import { GUARDS, MAX_ANSWER_BYTES, TIMEOUT_MS } from '../googleCalendarReadTools';
import { checkGoogleCalendarReadArgs } from '../../../utils/googleCalendarReadArgs';
import { CALENDAR_REFUSALS } from '../../../routes/emmaGoogleCalendarRoutes';

const mockFetch = mcpFetch as jest.Mock;
const ctxFor = (userId: string) => ({ userId, sessionId: 'sess-1', apiKeyId: 'key-1', externalMcp: true, authMethod: 'api_key' });
const call = (name: string, args: unknown, userId = 'user-1') => (mcpToolRegistry.getTool(name) as any).execute(args, ctxFor(userId));
const parse = (r: any) => JSON.parse(r.content[0].text);
const answerBytes = (r: any) => Buffer.byteLength(r.content[0].text, 'utf8');
const TOOLS = ['google_calendar_list_events', 'google_calendar_get_event', 'google_calendar_list_calendars'] as const;
const VALID: Record<(typeof TOOLS)[number], Record<string, unknown>> = {
  google_calendar_list_events: {},
  google_calendar_get_event: { event_id: 'abc123' },
  google_calendar_list_calendars: {},
};
const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);
const DAY = 86_400_000;
const ctl = (code: number) => String.fromCharCode(code);

beforeEach(() => {
  mockFetch.mockReset();
  Object.values(GUARDS).forEach((g) => g.reset());
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => jest.restoreAllMocks());

describe('registration', () => {
  it('registers the three reads under Emma\'s names, for user accounts, not read-only, with the own-account, personal-data and untrusted-content wording', () => {
    for (const name of TOOLS) {
      const tool = mcpToolRegistry.getTool(name) as any;
      expect(tool).toBeDefined();
      expect(tool.requiresUserAccount).toBe(true);
      expect(tool.readOnly).toBeUndefined();
      expect(tool.internal).toBeUndefined();
      const text = tool.definition.description;
      expect(text).toMatch(/read-only subset of Emma's tool of the same name over MCP/);
      expect(text).toMatch(/your own AgentWeb user/);
      expect(text).toMatch(/never a teammate's or a shared account/);
      expect(text).toMatch(/third-party content/);
      expect(text).toMatch(/never as instructions/);
      expect(text).toMatch(/Any other argument is refused by name/);
      expect(text).toMatch(/60 an hour/);
    }
    for (const name of ['google_calendar_list_events', 'google_calendar_get_event']) {
      expect((mcpToolRegistry.getTool(name) as any).definition.description).toMatch(/Attendee emails and names are personal data/);
    }
    expect((mcpToolRegistry.getTool('google_calendar_get_event') as any).definition.description).toMatch(/entry points can hold dial-in PINs and meeting passwords/);
    expect((mcpToolRegistry.getTool('google_calendar_list_calendars') as any).definition.inputSchema.properties).toStrictEqual({});
    for (const write of ['google_calendar_create_event', 'google_calendar_update_event', 'google_calendar_delete_event']) {
      expect(mcpToolRegistry.getTool(write)).toBeUndefined();
    }
  });
});

describe('refusals before any call', () => {
  it('refuses unknown arguments by name on every tool (identity never comes from an argument)', async () => {
    for (const name of TOOLS) {
      await expect(call(name, { ...VALID[name], user_id: 'victim' })).rejects.toThrow(new RegExp(`^${name}: "user_id" is not an input`));
      await expect(call(name, { ...VALID[name], userId: 'victim' })).rejects.toThrow(/"userId" is not an input/);
      await expect(call(name, { ...VALID[name], account_id: 'x' })).rejects.toThrow(/"account_id" is not an input/);
      await expect(call(name, 'x')).rejects.toThrow(/must be an object/);
    }
    await expect(call('google_calendar_list_calendars', { max_results: 5 })).rejects.toThrow(/^google_calendar_list_calendars: "max_results" is not an input/);
    await expect(call('google_calendar_list_events', { q: 'x' })).rejects.toThrow(/"q" is not an input/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('list_events: time_min / time_max are ISO 8601 date-times WITH a zone; the range is later-than and at most 92 days', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ time_min: '2026-11-01' }, /time_min must be an ISO 8601 date-time with a zone/],
      [{ time_min: '2026-11-01T09:00:00' }, /time_min must be an ISO 8601 date-time with a zone/],
      [{ time_min: '2026-11-01T09:00:00z' }, /time_min must be/],
      [{ time_min: '2026-11-01 09:00:00Z' }, /time_min must be/],
      [{ time_min: '2026-02-30T00:00:00Z' }, /time_min must be/],
      [{ time_min: '2026-11-01T24:00:00Z' }, /time_min must be/],
      [{ time_min: '2026-11-01T09:60:00Z' }, /time_min must be/],
      [{ time_min: '2026-11-01T09:00:00+15:00' }, /time_min must be/],
      [{ time_min: '2026-11-01T09:00:00+0530' }, /time_min must be/],
      [{ time_min: '1969-12-31T00:00:00Z' }, /time_min must be/],
      [{ time_min: 1767225600000 }, /time_min must be/],
      [{ time_min: 'now' }, /time_min must be/],
      [{ time_max: '2026-12-01T00:00:00Z&x=1' }, /time_max must be/],
      [{ time_min: '2026-11-02T00:00:00Z', time_max: '2026-11-01T00:00:00Z' }, /time_max must be later than time_min\. Nothing was changed\./],
      [{ time_min: '2026-11-02T00:00:00Z', time_max: '2026-11-02T00:00:00Z' }, /time_max must be later than time_min/],
      [{ time_min: '2026-01-01T00:00:00Z', time_max: '2026-04-03T00:00:01Z' }, /time_min to time_max must be at most 92 days\. Nothing was changed\./],
      [{ time_max: '2026-11-27T11:00:00Z' }, /time_max must be later than time_min \(time_min defaults to now\)/],
      [{ time_max: new Date(NOW + 92 * DAY + 1000).toISOString() }, /time_min to time_max must be at most 92 days \(time_min defaults to now\)/],
    ];
    for (const [args, re] of cases) {
      await expect(call('google_calendar_list_events', args)).rejects.toThrow(new RegExp(`^google_calendar_list_events: ${re.source}`));
    }
    await expect(call('google_calendar_list_events', { time_min: 'x' })).rejects.toThrow(/\. Nothing was changed\.$/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('list_events: max_results a whole number 1..100, query 1..200 characters on one line, calendar_id primary or the safe charset', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ max_results: 0 }, /max_results must be a whole number from 1 to 100/],
      [{ max_results: 101 }, /max_results must be a whole number from 1 to 100/],
      [{ max_results: 250 }, /max_results must be/],
      [{ max_results: 1.5 }, /max_results must be/],
      [{ max_results: -5 }, /max_results must be/],
      [{ max_results: '10' }, /max_results must be/],
      [{ max_results: Number.NaN }, /max_results must be/],
      [{ query: '' }, /query must be text of 1 to 200 characters/],
      [{ query: '   ' }, /query must be text/],
      [{ query: 'q'.repeat(201) }, /query must be text/],
      [{ query: `a${ctl(0)}b` }, /query must be text/],
      [{ query: 'a\nb' }, /query must be text/],
      [{ query: `a${ctl(0x202e)}b` }, /query must be text/],
      [{ query: `a${ctl(0x200b)}b` }, /query must be text/],
      [{ query: 5 }, /query must be text/],
      [{ calendar_id: '' }, /calendar_id must be primary or a calendar id/],
      [{ calendar_id: '..' }, /calendar_id must be/],
      [{ calendar_id: '.' }, /calendar_id must be/],
      [{ calendar_id: '#-' }, /calendar_id must be/],
      [{ calendar_id: 'a/b' }, /calendar_id must be/],
      [{ calendar_id: 'a b' }, /calendar_id must be/],
      [{ calendar_id: 'cal?x=1' }, /calendar_id must be/],
      [{ calendar_id: '%2e%2e' }, /calendar_id must be/],
      [{ calendar_id: 'c'.repeat(257) }, /calendar_id must be/],
      [{ calendar_id: 7 }, /calendar_id must be/],
    ];
    for (const [args, re] of cases) {
      await expect(call('google_calendar_list_events', args)).rejects.toThrow(new RegExp(`^google_calendar_list_events: ${re.source}`));
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('get_event: event_id 1..1024 of letters, digits or _ (required); calendar_id checked as above', async () => {
    const bad = [undefined, null, '', 'abc-def', 'a/b', '../x', 'abc def', 'abc.def', 'abc%2F', 'e'.repeat(1025), 42, ['abc']];
    for (const event_id of bad) {
      await expect(call('google_calendar_get_event', { event_id })).rejects.toThrow(/^google_calendar_get_event: event_id is required and must be an event id from google_calendar_list_events/);
    }
    await expect(call('google_calendar_get_event', { event_id: 'abc', calendar_id: '..' })).rejects.toThrow(/calendar_id must be/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('what is sent', () => {
  it('each tool POSTs { tool, args } with only checked values to the one route, with its timeout and the caller\'s own context', async () => {
    mockFetch.mockResolvedValue({ success: true, event: {} });
    await call('google_calendar_list_events', { time_min: '2026-11-01T09:00+05:30', time_max: '2026-11-30T23:59:59.5Z', calendar_id: 'en.usa#holiday@group.v.calendar.google.com', max_results: 20, query: '  board meeting ' });
    await call('google_calendar_get_event', { event_id: 'abc123_20261127T100000Z', calendar_id: 'primary' });
    await call('google_calendar_list_calendars', {});
    const sent = mockFetch.mock.calls.map((c) => c[0]);
    expect(sent.map((r) => [r.method, r.path, r.timeoutMs])).toEqual([
      ['POST', '/api/emma/google-calendar-read', TIMEOUT_MS],
      ['POST', '/api/emma/google-calendar-read', TIMEOUT_MS],
      ['POST', '/api/emma/google-calendar-read', TIMEOUT_MS],
    ]);
    expect(TIMEOUT_MS).toBe(60_000);
    expect(sent[0].body).toStrictEqual({
      tool: 'google_calendar_list_events',
      args: { time_min: '2026-11-01T03:30:00.000Z', time_max: '2026-11-30T23:59:59.500Z', calendar_id: 'en.usa#holiday@group.v.calendar.google.com', max_results: 20, query: 'board meeting' },
    });
    expect(sent[1].body).toStrictEqual({ tool: 'google_calendar_get_event', args: { event_id: 'abc123_20261127T100000Z', calendar_id: 'primary' } });
    expect(sent[2].body).toStrictEqual({ tool: 'google_calendar_list_calendars', args: {} });
    for (const r of sent) {
      expect(r.context.userId).toBe('user-1');
      expect(r.context).not.toHaveProperty('apiKeyId');
      expect(JSON.stringify(r.body)).not.toMatch(/user/i);
    }
  });

  it('the range is filled in: time_min defaults to now, time_max to 7 days after time_min; nulls count as absent', async () => {
    mockFetch.mockResolvedValue({ success: true, events: [] });
    await call('google_calendar_list_events', {});
    await call('google_calendar_list_events', { time_min: '2027-01-10T00:00:00Z', time_max: null, max_results: null });
    await call('google_calendar_list_events', { time_max: new Date(NOW + 92 * DAY).toISOString() });
    expect(mockFetch.mock.calls[0][0].body.args).toStrictEqual({ time_min: new Date(NOW).toISOString(), time_max: new Date(NOW + 7 * DAY).toISOString() });
    expect(mockFetch.mock.calls[1][0].body.args).toStrictEqual({ time_min: '2027-01-10T00:00:00.000Z', time_max: '2027-01-17T00:00:00.000Z' });
    expect(mockFetch.mock.calls[2][0].body.args).toStrictEqual({ time_min: new Date(NOW).toISOString(), time_max: new Date(NOW + 92 * DAY).toISOString() });
  });

  it('the shared check is the same one the route runs: what it sends passes it again unchanged', () => {
    const first = checkGoogleCalendarReadArgs('google_calendar_list_events', { time_min: '2026-11-01T09:00:00-07:00', query: ' x ' }, NOW);
    expect(first.ok).toBe(true);
    const again = checkGoogleCalendarReadArgs('google_calendar_list_events', (first as any).args, NOW + 5000);
    expect(again).toStrictEqual(first);
  });
});

describe('answers: fixed fields only', () => {
  it('list_events answers fixed event fields; anything else Emma or Google sent is left out; non-https links dropped', async () => {
    mockFetch.mockResolvedValueOnce({
      success: true, calendar_id: 'primary', time_min: 'x', time_max: 'y', count: 1, status: 200, nextPageToken: 'tok',
      events: [{
        id: 'ev1', title: 'Board', start: '2026-11-28T10:00:00Z', end: '2026-11-28T11:00:00Z', all_day: false, location: 'Room 1',
        description: 'Agenda', status: 'confirmed', organizer: 'boss@example.com', etag: 'secret-etag', creator: { email: 'c@example.com' },
        attendees: [{ email: 'a@example.com', name: 'A', response: 'accepted', self: true, comment: 'private note' }],
        meeting_link: 'https://meet.google.com/abc-defg-hij', html_link: 'javascript:alert(1)',
      }],
    });
    const a = parse(await call('google_calendar_list_events', { time_min: '2026-11-28T00:00:00Z' }));
    expect(a).toStrictEqual({
      calendar_id: 'primary', time_min: '2026-11-28T00:00:00.000Z', time_max: '2026-12-05T00:00:00.000Z', total: 1, count: 1,
      events: [{
        id: 'ev1', title: 'Board', start: '2026-11-28T10:00:00Z', end: '2026-11-28T11:00:00Z', all_day: false, location: 'Room 1',
        description: 'Agenda', status: 'confirmed', organizer: 'boss@example.com', attendee_count: 1,
        attendees: [{ email: 'a@example.com', name: 'A', response: 'accepted', self: true }],
        meeting_link: 'https://meet.google.com/abc-defg-hij',
      }],
    });
    expect(JSON.stringify(a)).not.toMatch(/secret-etag|c@example.com|private note|javascript|nextPageToken|tok/);
  });

  it('get_event answers the full fixed fields; conference entry points are kept (PINs as in Emma), unknown schemes dropped', async () => {
    mockFetch.mockResolvedValueOnce({
      success: true,
      event: {
        id: 'ev1', title: 'Call', start: '2026-11-28', end: '2026-11-29', all_day: true, status: 'confirmed',
        organizer: { email: 'o@example.com', name: 'O', self: true }, attendees: [{ email: 'x@example.com', name: null, response: 'needsAction', self: false, optional: true }],
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=FR', 7],
        conference_data: { type: 'Google Meet', conferenceId: 'secret-conf', entry_points: [
          { type: 'video', uri: 'https://meet.google.com/abc-defg-hij', label: 'meet.google.com/abc-defg-hij' },
          { type: 'phone', uri: 'tel:+1-555-0100;pin=123456', label: '+1 555-0100', pin: '123456' },
          { type: 'more', uri: 'file:///etc/passwd', label: 'x' },
        ] },
        html_link: 'https://www.google.com/calendar/event?eid=abc', created: '2026-11-01T00:00:00Z', updated: '2026-11-02T00:00:00Z', hangoutLink: 'raw',
      },
    });
    const a = parse(await call('google_calendar_get_event', { event_id: 'ev1' }));
    expect(a).toStrictEqual({
      event: {
        id: 'ev1', title: 'Call', start: '2026-11-28', end: '2026-11-29', all_day: true, status: 'confirmed',
        organizer: { email: 'o@example.com', name: 'O' }, attendee_count: 1,
        attendees: [{ email: 'x@example.com', response: 'needsAction', self: false, optional: true }],
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=FR'],
        conference_data: { type: 'Google Meet', entry_points: [
          { type: 'video', uri: 'https://meet.google.com/abc-defg-hij', label: 'meet.google.com/abc-defg-hij' },
          { type: 'phone', uri: 'tel:+1-555-0100;pin=123456', label: '+1 555-0100' },
          { type: 'more', label: 'x' },
        ] },
        html_link: 'https://www.google.com/calendar/event?eid=abc', created: '2026-11-01T00:00:00Z', updated: '2026-11-02T00:00:00Z',
      },
    });
    expect(JSON.stringify(a)).not.toMatch(/secret-conf|file:|hangoutLink/);
    mockFetch.mockResolvedValueOnce({ success: true });
    await expect(call('google_calendar_get_event', { event_id: 'ev1' })).rejects.toThrow('google_calendar_get_event: the service gave no event. Nothing was changed.');
  });

  it('list_calendars answers fixed calendar fields only', async () => {
    mockFetch.mockResolvedValueOnce({ success: true, count: 1, calendars: [{ id: 'primary@example.com', name: 'Me', description: null, color: '#fff', access_role: 'owner', primary: true, selected: true, etag: 'e', kind: 'k' }] });
    const a = parse(await call('google_calendar_list_calendars', {}));
    expect(a).toStrictEqual({ total: 1, count: 1, calendars: [{ id: 'primary@example.com', name: 'Me', color: '#fff', access_role: 'owner', primary: true, selected: true }] });
  });
});

describe('size cap: about 60 KB as sent, attendee lists cut first', () => {
  const attendees = (n: number) => Array.from({ length: n }, (_, i) => ({ email: `person${i}@example.com`, name: `Person ${i}`, response: 'accepted', self: false }));

  it('many events with long attendee lists: every event kept, each attendee list cut, attendee_count kept, truncated', async () => {
    const events = Array.from({ length: 40 }, (_, i) => ({ id: `ev${i}`, title: `E${i}`, attendees: attendees(150) }));
    mockFetch.mockResolvedValueOnce({ success: true, events });
    const r = await call('google_calendar_list_events', {});
    expect(answerBytes(r)).toBeLessThanOrEqual(MAX_ANSWER_BYTES);
    const a = parse(r);
    expect(a).toMatchObject({ total: 40, count: 40, truncated: true });
    expect(a.attendees_cut_to).toBeGreaterThan(0);
    expect(a.attendees_cut_to).toBeLessThan(150);
    expect(a.truncated_note).toMatch(/Attendee lists are cut to \d+ per event/);
    expect(a.truncated_note).not.toMatch(/events fit/);
    for (const e of a.events) {
      expect(e.attendee_count).toBe(150);
      expect(e.attendees.length).toBe(a.attendees_cut_to);
    }
  });

  it('when even no attendees do not fit, attendee lists are emptied and then the events are cut, with a note', async () => {
    const events = Array.from({ length: 100 }, (_, i) => ({ id: `ev${i}`, title: 't'.repeat(200), description: 'd'.repeat(500), location: 'l'.repeat(200), attendees: attendees(3) }));
    mockFetch.mockResolvedValueOnce({ success: true, events });
    const r = await call('google_calendar_list_events', { max_results: 100 });
    expect(answerBytes(r)).toBeLessThanOrEqual(MAX_ANSWER_BYTES);
    const a = parse(r);
    expect(a).toMatchObject({ total: 100, truncated: true, attendees_cut_to: 0 });
    expect(a.count).toBeLessThan(100);
    expect(a.count).toBeGreaterThan(10);
    expect(a.events[0].id).toBe('ev0');
    expect(a.events.every((e: any) => e.attendees.length === 0 && e.attendee_count === 3)).toBe(true);
    expect(a.truncated_note).toMatch(new RegExp(`Only ${a.count} of 100 events fit in one answer: narrow time_min / time_max`));
  });

  it('the worst single list event (every character escaped) still fits, so an answer is never empty', async () => {
    const x = ctl(1);
    const big = { id: x.repeat(5000), title: x.repeat(5000), location: x.repeat(5000), description: x.repeat(5000), start: x.repeat(99), end: x.repeat(99), status: x.repeat(99), organizer: x.repeat(5000), attendees: attendees(200), meeting_link: `https://${'a'.repeat(490)}`, html_link: `https://${'"'.repeat(490)}` };
    mockFetch.mockResolvedValueOnce({ success: true, events: [big] });
    const one = await call('google_calendar_list_events', {});
    expect(answerBytes(one)).toBeLessThanOrEqual(MAX_ANSWER_BYTES);
    expect(parse(one)).toMatchObject({ total: 1, count: 1 });
    mockFetch.mockResolvedValueOnce({ success: true, events: [big, big, big, big, big] });
    const r = await call('google_calendar_list_events', {});
    expect(answerBytes(r)).toBeLessThanOrEqual(MAX_ANSWER_BYTES);
    const a = parse(r);
    expect(a).toMatchObject({ total: 5, truncated: true, attendees_cut_to: 0 });
    expect(a.count).toBeGreaterThanOrEqual(1);
    expect(a.count).toBeLessThan(5);
  });

  it('get_event: a long attendee list is cut to what fits, with truncated and a note', async () => {
    mockFetch.mockResolvedValueOnce({ success: true, event: { id: 'ev1', title: 'All hands', attendees: attendees(2000) } });
    const r = await call('google_calendar_get_event', { event_id: 'ev1' });
    expect(answerBytes(r)).toBeLessThanOrEqual(MAX_ANSWER_BYTES);
    const a = parse(r);
    expect(a.truncated).toBe(true);
    expect(a.event.attendee_count).toBe(2000);
    expect(a.event.attendees.length).toBeGreaterThan(100);
    expect(a.event.attendees.length).toBeLessThan(500);
    expect(a.truncated_note).toBe(`Only the first ${a.event.attendees.length} of 2000 attendees fit in one answer.`);
  });

  it('get_event: an event that is over the cap without attendees has its texts cut shorter until it fits', async () => {
    const x = ctl(1);
    const entry = { type: x.repeat(500), uri: 'https://a.example/x', label: x.repeat(500) };
    mockFetch.mockResolvedValueOnce({ success: true, event: { id: 'ev1', title: x.repeat(500), description: x.repeat(5000), recurrence: Array.from({ length: 10 }, () => x.repeat(600)), conference_data: { type: x.repeat(500), entry_points: Array.from({ length: 20 }, () => entry) }, attendees: attendees(5) } });
    const r = await call('google_calendar_get_event', { event_id: 'ev1' });
    expect(answerBytes(r)).toBeLessThanOrEqual(MAX_ANSWER_BYTES);
    const a = parse(r);
    expect(a).toMatchObject({ truncated: true, item_texts_cut: true, event: { attendee_count: 5, attendees: [] } });
  });

  it('list_calendars: a list over the cap is cut with truncated', async () => {
    const x = ctl(1);
    const calendars = Array.from({ length: 100 }, (_, i) => ({ id: `cal${i}@example.com`, name: x.repeat(200), description: x.repeat(500), access_role: 'reader' }));
    mockFetch.mockResolvedValueOnce({ success: true, calendars });
    const r = await call('google_calendar_list_calendars', {});
    expect(answerBytes(r)).toBeLessThanOrEqual(MAX_ANSWER_BYTES);
    const a = parse(r);
    expect(a).toMatchObject({ total: 100, truncated: true });
    expect(a.count).toBeLessThan(100);
    expect(a.calendars[0].id).toBe('cal0@example.com');
    expect(a.truncated_note).toBe(`Only ${a.count} of 100 calendars fit in one answer.`);
  });
});

describe('errors', () => {
  it('a refusal (success: false) carries only the route\'s fixed message, with a final full stop', async () => {
    mockFetch.mockResolvedValueOnce({ success: false, reason: 'not_connected', message: CALENDAR_REFUSALS.not_connected, status: 401, stack: 'at x' });
    await expect(call('google_calendar_list_events', {})).rejects.toThrow(`google_calendar_list_events: ${CALENDAR_REFUSALS.not_connected}.`);
    mockFetch.mockResolvedValueOnce({ success: false, reason: 'not_found', message: CALENDAR_REFUSALS.not_found });
    const e = await call('google_calendar_get_event', { event_id: 'abc' }).catch((err: Error) => err);
    expect(e.message).toMatch(/^google_calendar_get_event: Google found no such calendar or event .* Nothing was changed\.$/);
    mockFetch.mockResolvedValueOnce(undefined);
    await expect(call('google_calendar_list_calendars', {})).rejects.toThrow('google_calendar_list_calendars: the service gave no answer.');
  });

  it('a 4xx passes through as it is (quota, a refused body, a sandbox)', async () => {
    for (const message of ['API error (429): Monthly token quota reached', 'API error (400): time_min must be an ISO 8601 date-time', 'API error (403): This tool is not available in this sandbox workspace']) {
      mockFetch.mockRejectedValueOnce(new Error(message));
      await expect(call('google_calendar_list_events', {})).rejects.toThrow(message);
    }
  });

  it('a 5xx or an unreachable route is a fixed text that never carries the internal detail', async () => {
    mockFetch.mockRejectedValueOnce(new Error('API error (500): invalid_grant: Token has been expired or revoked at /var/app/current'));
    const e1 = await call('google_calendar_list_events', {}).catch((e: Error) => e);
    expect(e1.message).toBe('google_calendar_list_events: the service could not answer (HTTP 500). Try again later. Nothing was changed.');
    mockFetch.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'));
    const e2 = await call('google_calendar_get_event', { event_id: 'a1' }).catch((e: Error) => e);
    expect(e2.message).toBe('google_calendar_get_event: the service could not be reached or did not answer in time. Try again later. Nothing was changed.');
  });
});

describe('guards', () => {
  it('caps per tool: 4 at a time per process, 60 an hour per caller', () => {
    for (const name of TOOLS) expect([GUARDS[name].processMax, GUARDS[name].perHour]).toEqual([4, 60]);
  });

  it('one call at a time per caller, a process cap across callers, and the slot is freed after a failure', async () => {
    let release!: (v: unknown) => void;
    mockFetch.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = call('google_calendar_list_events', {}, 'u1');
    await expect(call('google_calendar_list_events', {}, 'u1')).rejects.toThrow(/another call of yours to this tool is still running/);
    // another tool is its own guard
    mockFetch.mockResolvedValueOnce({ success: true, calendars: [] });
    await expect(call('google_calendar_list_calendars', {}, 'u1')).resolves.toBeDefined();
    const pending: Array<(v: unknown) => void> = [];
    mockFetch.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
    const others = ['u2', 'u3', 'u4'].map((u) => call('google_calendar_list_events', {}, u));
    await expect(call('google_calendar_list_events', {}, 'u5')).rejects.toThrow(/this tool is busy/);
    release({ success: true, events: [] });
    pending.forEach((r) => r({ success: true, events: [] }));
    await Promise.all([first, ...others]);
    expect(GUARDS.google_calendar_list_events.inFlight).toBe(0);
    mockFetch.mockReset();
    mockFetch.mockRejectedValueOnce(new Error('API error (502): bad gateway'));
    await expect(call('google_calendar_list_events', {}, 'u1')).rejects.toThrow(/HTTP 502/);
    expect(GUARDS.google_calendar_list_events.callers.has('u1')).toBe(false);
  });

  it('an hourly cap per caller: the next call is refused before anything is called; another caller is not affected', async () => {
    mockFetch.mockResolvedValue({ success: true, calendars: [] });
    for (let i = 0; i < 60; i++) await call('google_calendar_list_calendars', {}, 'heavy');
    await expect(call('google_calendar_list_calendars', {}, 'heavy')).rejects.toThrow(/you have made 60 calls to this tool in the last hour/);
    expect(mockFetch).toHaveBeenCalledTimes(60);
    await expect(call('google_calendar_list_calendars', {}, 'light')).resolves.toBeDefined();
  });

  it('a refused argument does not use up a call', async () => {
    for (let i = 0; i < 70; i++) await expect(call('google_calendar_get_event', { event_id: 'a/b' }, 'u9')).rejects.toThrow(/event_id/);
    expect(GUARDS.google_calendar_get_event.recent.get('u9')).toBeUndefined();
  });
});
