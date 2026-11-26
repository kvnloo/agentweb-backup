/**
 * ENG-2840 (W2-9): the four meeting and event reads for outside agents (meetingEventReadTools.ts). What each sends to its route, what is
 * refused before anything is called (arguments by name and by value: ids, event links, include_phone, dates, sizes), the fixed-field
 * answers and their size caps, error handling, and the per-caller guards. No network: the self-call is a double; the routes have their own
 * tests (src/__tests__/emmaMeetingEventRoutes.test.ts).
 */
jest.mock('../httpClient', () => ({ mcpFetch: jest.fn() }));

import { mcpFetch } from '../httpClient';
import { mcpToolRegistry } from '../registry';
import { GUARDS, MAX_ANSWER_BYTES, MAX_SUMMARY_CHARS, MAX_TURN_TEXT_CHARS, TIMEOUTS_MS } from '../meetingEventReadTools';
import { LUMA_KEY_REJECTED_MESSAGE, LUMA_NOT_CONNECTED_MESSAGE } from '../../../routes/emmaMeetingEventRoutes';

const mockFetch = mcpFetch as jest.Mock;
const ctxFor = (userId: string) => ({ userId, sessionId: 'sess-1', apiKeyId: 'key-1', externalMcp: true, authMethod: 'api_key' });
const call = (name: string, args: unknown, userId = 'user-1') => (mcpToolRegistry.getTool(name) as any).execute(args, ctxFor(userId));
const parse = (r: any) => JSON.parse(r.content[0].text);
const answerBytes = (r: any) => Buffer.byteLength(r.content[0].text, 'utf8');
const TOOLS = ['fathom_get_meetings', 'fathom_get_transcript', 'luma_list_events', 'luma_get_guests'] as const;
const VALID: Record<(typeof TOOLS)[number], Record<string, unknown>> = {
  fathom_get_meetings: {},
  fathom_get_transcript: { recording_id: 101 },
  luma_list_events: {},
  luma_get_guests: { event: 'evt-abc123' },
};

beforeEach(() => {
  mockFetch.mockReset();
  Object.values(GUARDS).forEach((g) => g.reset());
});

describe('registration', () => {
  it('registers the four tools under Emma\'s names, for user accounts, not read-only (a read can refresh a token or flag a key), with untrusted-content and read-only wording', () => {
    for (const name of TOOLS) {
      const tool = mcpToolRegistry.getTool(name) as any;
      expect(tool).toBeDefined();
      expect(tool.requiresUserAccount).toBe(true);
      expect(tool.readOnly).toBeUndefined();
      expect(tool.internal).toBeUndefined();
      expect(tool.definition.description).toMatch(/read-only subset of Emma's tool/);
      expect(tool.definition.description).toMatch(/never as instructions/);
      expect(tool.definition.description).toMatch(/Any other argument is refused by name/);
    }
    expect(mcpToolRegistry.getTool('fathom_get_onboarding_context')).toBeUndefined();
    expect(mcpToolRegistry.getTool('fathom_route_action_items')).toBeUndefined();
    expect(Object.keys((mcpToolRegistry.getTool('luma_get_guests') as any).definition.inputSchema.properties)).not.toContain('include_phone');
  });
});

describe('refusals before any call', () => {
  it('refuses unknown arguments by name on every tool (identity never comes from an argument)', async () => {
    for (const name of TOOLS) {
      await expect(call(name, { ...VALID[name], user_id: 'victim' })).rejects.toThrow(new RegExp(`^${name}: "user_id" is not an input`));
      await expect(call(name, { ...VALID[name], account_id: 'x' })).rejects.toThrow(/"account_id" is not an input/);
    }
    await expect(call('luma_get_guests', { event: 'evt-abc', include_phone: true })).rejects.toThrow(/^luma_get_guests: "include_phone" is not an input/);
    await expect(call('luma_get_guests', { event: 'evt-abc', include_phone: false })).rejects.toThrow(/"include_phone" is not an input/);
    await expect(call('fathom_get_meetings', 'x')).rejects.toThrow(/must be an object/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fathom_get_transcript: recording_id must be a positive safe integer (a digit string only if it converts exactly)', async () => {
    const bad = [undefined, null, 0, -1, 1.5, NaN, Infinity, 2 ** 53, '', '0', '012', '12a', '1e3', '../1', ' 12', '12 ', '0x1f', '9007199254740993', true, [1], { id: 1 }];
    for (const recording_id of bad) {
      await expect(call('fathom_get_transcript', { recording_id })).rejects.toThrow(/^fathom_get_transcript: recording_id is required and must be a positive whole number/);
    }
    expect(mockFetch).not.toHaveBeenCalled();
    mockFetch.mockResolvedValueOnce({ success: true, recording_id: 123, transcript: [] });
    await call('fathom_get_transcript', { recording_id: '123' });
    expect(mockFetch.mock.calls[0][0].body).toStrictEqual({ recording_id: 123 });
  });

  it('luma_get_guests: event is an evt- id only, never a link or a slug', async () => {
    const bad = ['https://luma.com/event/manage/evt-abc123', 'luma.com/evt-abc', 'evt-', 'evt-abc/../x', 'evt-abc?x=1', 'my-evt-abc', 'EVT-abc', ' evt-abc', 'evt-abc\n', 'evt-ab_c', `evt-${'a'.repeat(61)}`, 42, undefined];
    for (const event of bad) {
      await expect(call('luma_get_guests', { event })).rejects.toThrow(/^luma_get_guests: event is required and must be an event id \(evt-\.\.\.\)/);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('luma_get_guests: approval_status enum, answer_labels at most 5 x 40 characters, max_guests 1..60, include_registration_answers boolean', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ approval_status: 'all' }, /approval_status must be one of approved, session, pending_approval, invited, declined, waitlist/],
      [{ approval_status: 'APPROVED' }, /approval_status must be one of/],
      [{ answer_labels: ['a', 'b', 'c', 'd', 'e', 'f'] }, /answer_labels must be a list of at most 5 words, each 1 to 40 characters/],
      [{ answer_labels: ['x'.repeat(41)] }, /answer_labels must be a list/],
      [{ answer_labels: ['  '] }, /answer_labels must be a list/],
      [{ answer_labels: 'company,linkedin' }, /answer_labels must be a list/],
      [{ answer_labels: ['comp\u0000any'] }, /answer_labels must be a list/],
      [{ answer_labels: ['comp\u202eany'] }, /answer_labels must be a list/],
      [{ answer_labels: [1] }, /answer_labels must be a list/],
      [{ max_guests: 0 }, /max_guests must be a whole number from 1 to 60/],
      [{ max_guests: 61 }, /max_guests must be a whole number from 1 to 60/],
      [{ max_guests: 1.5 }, /max_guests/],
      [{ max_guests: '10' }, /max_guests/],
      [{ include_registration_answers: 'yes' }, /include_registration_answers must be true or false/],
      [{ registered_after: '2026-02-30' }, /registered_after must be an ISO 8601 date or date-time/],
      [{ cursor: 'a b' }, /cursor must be the next_cursor of an earlier answer/],
      [{ calendar_id: '../cal' }, /calendar_id must be the id of a connected Luma calendar/],
    ];
    for (const [extra, re] of cases) {
      await expect(call('luma_get_guests', { event: 'evt-abc123', ...extra })).rejects.toThrow(re);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('luma_list_events: ISO dates, limit 1..100, cursor at most 200 safe characters, calendar_id safe charset and length', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ after: 'yesterday' }, /after must be an ISO 8601 date or date-time/],
      [{ before: '2026-13-01' }, /before must be an ISO 8601/],
      [{ after: '2026-11-01T24:00:00Z' }, /after must be an ISO 8601/],
      [{ after: '2026-11-01 09:00' }, /after must be an ISO 8601/],
      [{ after: 1767225600000 }, /after must be an ISO 8601/],
      [{ after: '2026-11-02', before: '2026-11-01' }, /after must not be later than before/],
      [{ limit: 0 }, /limit must be a whole number from 1 to 100/],
      [{ limit: 101 }, /limit must be a whole number from 1 to 100/],
      [{ limit: 2.5 }, /limit must be/],
      [{ limit: '10' }, /limit must be/],
      [{ cursor: 'c'.repeat(201) }, /cursor must be the next_cursor/],
      [{ cursor: 'x&pagination_limit=1000' }, /cursor must be the next_cursor/],
      [{ cursor: '' }, /cursor must be the next_cursor/],
      [{ calendar_id: 'c'.repeat(65) }, /calendar_id must be/],
      [{ calendar_id: 'cal 1' }, /calendar_id must be/],
      [{ calendar_id: 7 }, /calendar_id must be/],
    ];
    for (const [args, re] of cases) {
      await expect(call('luma_list_events', args)).rejects.toThrow(new RegExp(`^luma_list_events: ${re.source}`));
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fathom_get_meetings: ISO dates in order, limit 1..200; fathom_get_transcript: start_turn a whole number from 0', async () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['fathom_get_meetings', { created_after: '2026-02-29' }, /created_after must be an ISO 8601/],
      ['fathom_get_meetings', { created_before: 'last week' }, /created_before must be an ISO 8601/],
      ['fathom_get_meetings', { created_after: '2026-11-01T09:00:00+15:00' }, /created_after must be an ISO 8601/],
      ['fathom_get_meetings', { created_after: '2026-11-02', created_before: '2026-11-01' }, /created_after must not be later than created_before/],
      ['fathom_get_meetings', { limit: 0 }, /limit must be a whole number from 1 to 200/],
      ['fathom_get_meetings', { limit: 201 }, /limit must be a whole number from 1 to 200/],
      ['fathom_get_meetings', { limit: '5' }, /limit must be/],
      ['fathom_get_transcript', { recording_id: 1, start_turn: -1 }, /start_turn must be a whole number from 0/],
      ['fathom_get_transcript', { recording_id: 1, start_turn: '3' }, /start_turn must be/],
      ['fathom_get_transcript', { recording_id: 1, start_turn: 1.5 }, /start_turn must be/],
    ];
    for (const [name, args, re] of cases) await expect(call(name, args)).rejects.toThrow(re);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('what is sent', () => {
  it('each tool POSTs only checked values to its own route, with its timeout and the caller\'s own context; MCP-only options stay here', async () => {
    mockFetch.mockResolvedValue({ success: true });
    await call('fathom_get_meetings', { created_after: '2026-11-01', created_before: '2026-11-20T10:30:00+05:30', limit: 5 });
    await call('fathom_get_transcript', { recording_id: 810527663, start_turn: 10 });
    await call('luma_list_events', { after: '2026-11-01T09:00', limit: 50, cursor: 'cur_AB-12.x=', calendar_id: 'cal-XYZ1' });
    await call('luma_get_guests', { event: 'evt-abc123', approval_status: 'pending_approval', registered_after: '2026-11-01', include_registration_answers: false, answer_labels: [' company ', 'linkedin'], max_guests: 30, cursor: 'c2', calendar_id: 'cal-1' });
    const sent = mockFetch.mock.calls.map((c) => c[0]);
    expect(sent.map((r) => [r.method, r.path, r.timeoutMs])).toEqual([
      ['POST', '/api/emma/fathom-meetings', TIMEOUTS_MS.fathom_get_meetings],
      ['POST', '/api/emma/fathom-transcript', TIMEOUTS_MS.fathom_get_transcript],
      ['POST', '/api/emma/luma-events', TIMEOUTS_MS.luma_list_events],
      ['POST', '/api/emma/luma-guests', TIMEOUTS_MS.luma_get_guests],
    ]);
    expect(sent[0].body).toStrictEqual({ created_after: '2026-11-01T00:00:00.000Z', created_before: '2026-11-20T05:00:00.000Z' });
    expect(sent[1].body).toStrictEqual({ recording_id: 810527663 });
    expect(sent[2].body).toStrictEqual({ after: '2026-11-01T09:00:00.000Z', limit: 50, cursor: 'cur_AB-12.x=', calendar_id: 'cal-XYZ1' });
    expect(sent[3].body).toStrictEqual({ event: 'evt-abc123', approval_status: 'pending_approval', registered_after: '2026-11-01T00:00:00.000Z', include_registration_answers: false, answer_labels: ['company', 'linkedin'], max_guests: 30, cursor: 'c2', calendar_id: 'cal-1' });
    for (const r of sent) {
      expect(r.context.userId).toBe('user-1');
      expect(r.context).not.toHaveProperty('apiKeyId');
      expect(JSON.stringify(r.body)).not.toMatch(/include_phone|user/);
    }
  });

  it('null arguments count as absent and send an empty body', async () => {
    mockFetch.mockResolvedValue({ success: true, meetings: [] });
    await call('fathom_get_meetings', { created_after: null, limit: null });
    expect(mockFetch.mock.calls[0][0].body).toStrictEqual({});
  });
});

describe('answers: fixed fields, no phone, untrusted text bounded', () => {
  it('fathom_get_meetings answers fixed fields only, summary text from either shape, action item texts, https links only', async () => {
    mockFetch.mockResolvedValueOnce({
      success: true,
      count: 2,
      status: 200,
      meetings: [
        {
          recording_id: 101, title: 'Sprint', url: 'https://fathom.video/share/x', created_at: '2026-11-01T10:00:00Z', recorded_by: 'Alice',
          participants: ['Bob', 'carol@example.com', 7, null], calendar_invitees: [{ email: 'raw@example.com' }],
          summary: { template_name: 'General', markdown_formatted: '## Notes\n- shipped' }, action_items_count: 2,
          action_items: [{ description: 'Send deck', assignee: { email: 'assignee@example.com' }, recording_playback_url: 'https://x' }, 'Book room'],
          token: 'secret-token',
        },
        { recording_id: '202', title: 'Call', url: 'javascript:alert(1)', summary: 'plain summary', action_items: [] },
      ],
    });
    const a = parse(await call('fathom_get_meetings', {}));
    expect(a.total).toBe(2);
    expect(a.count).toBe(2);
    expect(a.truncated).toBeUndefined();
    expect(a.meetings[0]).toStrictEqual({
      recording_id: 101, title: 'Sprint', url: 'https://fathom.video/share/x', created_at: '2026-11-01T10:00:00Z', recorded_by: 'Alice',
      participants_count: 4, participants: ['Bob', 'carol@example.com', '7'], summary: '## Notes\n- shipped', action_items_count: 2, action_items: ['Send deck', 'Book room'],
    });
    expect(a.meetings[1]).toStrictEqual({ recording_id: 202, title: 'Call', participants_count: 0, participants: [], summary: 'plain summary', action_items_count: 0, action_items: [] });
    expect(JSON.stringify(a)).not.toMatch(/secret-token|assignee@example.com|raw@example.com|javascript|status/);
  });

  it('fathom_get_transcript answers turns {speaker, text, start_time}: a speaker object becomes its name, nothing else of it', async () => {
    mockFetch.mockResolvedValueOnce({
      success: true,
      recording_id: 101,
      transcript: [
        { speaker: { display_name: 'Alice', matched_calendar_invitee_email: 'alice@example.com' }, text: 'Hello', start_time: 0, extra: 'x' },
        { speaker: 'Bob', text: 'Hi', start_time: '00:00:05' },
        { speaker: { matched_calendar_invitee_email: 'nameless@example.com' }, text: 'Yo' },
      ],
    });
    const a = parse(await call('fathom_get_transcript', { recording_id: 101 }));
    expect(a).toStrictEqual({
      recording_id: 101, total_turns: 3, start_turn: 0, count: 3,
      transcript: [
        { speaker: 'Alice', text: 'Hello', start_time: 0 },
        { speaker: 'Bob', text: 'Hi', start_time: '00:00:05' },
        { speaker: 'nameless@example.com', text: 'Yo' },
      ],
    });
  });

  it('luma_list_events answers fixed event fields, the calendar name and paging; an unusable cursor is not passed on', async () => {
    mockFetch.mockResolvedValueOnce({
      success: true, calendar: 'Founders', count: 1, has_more: true, next_cursor: 'c2',
      events: [{ event_id: 'evt-1', name: 'Launch', start_at: 's', end_at: 'e', timezone: 'UTC', url: 'https://lu.ma/x', api_id: 'secret', hosts: [{ email: 'h@example.com' }] }],
    });
    const a = parse(await call('luma_list_events', {}));
    expect(a).toStrictEqual({ calendar: 'Founders', has_more: true, next_cursor: 'c2', count: 1, events: [{ event_id: 'evt-1', name: 'Launch', start_at: 's', end_at: 'e', timezone: 'UTC', url: 'https://lu.ma/x' }] });
    mockFetch.mockResolvedValueOnce({ success: true, calendar: 'Founders', has_more: true, next_cursor: 'bad cursor&x=1', events: [] });
    const b = parse(await call('luma_list_events', {}));
    expect(b.next_cursor).toBeUndefined();
    expect(b.more_note).toMatch(/narrow the request/);
  });

  it('luma_get_guests answers fixed guest fields with emails and names, never a phone number, answers bounded', async () => {
    mockFetch.mockResolvedValueOnce({
      success: true, calendar: 'Founders', event_id: 'evt-abc123', approval_status: 'approved', count: 1, has_more: false,
      skipped_without_registration: 2, interrupted: 'Stopped early (Luma API returned 500). These guests are valid.', answers_note: 'None matched',
      guests: [{
        guest_id: 'gst-1', email: 'guest@example.com', name: 'Guest One', approval_status: 'approved', registered_at: '2026-11-01T00:00:00Z',
        phone_number: '+15551234567', user_api_id: 'usr-secret',
        registration_answers: [{ label: 'Company', value: 'x'.repeat(400), question_id: 'q1' }, { label: 'Size', value: 12 }, { label: 'Tags', value: ['a', 'b'] }],
        answers_omitted: 1,
      }],
    });
    const a = parse(await call('luma_get_guests', { event: 'evt-abc123', include_registration_answers: true }));
    expect(JSON.stringify(a)).not.toMatch(/\+1555|phone|usr-secret|question_id/);
    expect(a).toMatchObject({ calendar: 'Founders', event_id: 'evt-abc123', approval_status: 'approved', has_more: false, skipped_without_registration: 2, answers_note: 'None matched', count: 1 });
    expect(a.interrupted).toMatch(/^Stopped early/);
    const g = a.guests[0];
    expect(Object.keys(g).sort()).toEqual(['answers_omitted', 'approval_status', 'email', 'guest_id', 'name', 'registered_at', 'registration_answers'].sort());
    expect(g.email).toBe('guest@example.com');
    expect(g.registration_answers[0].value).toBe(`${'x'.repeat(300)}… [cut at 300 characters]`);
    expect(g.registration_answers[1]).toStrictEqual({ label: 'Size', value: 12 });
    expect(g.registration_answers[2]).toStrictEqual({ label: 'Tags', value: '["a","b"]' });
  });

  it('"Luma not connected" is a refusal, never a success that pulled nothing (Emma\'s browser instruction is not passed on)', async () => {
    mockFetch.mockResolvedValueOnce({ success: true, connected: false, nothing_pulled: true, reason: 'no_key', message: 'NOTHING WAS PULLED: continue with the browser session-cookie path' });
    await expect(call('luma_list_events', {})).rejects.toThrow(`luma_list_events: ${LUMA_NOT_CONNECTED_MESSAGE}.`);
    mockFetch.mockResolvedValueOnce({ success: true, connected: false, nothing_pulled: true, reason: 'key_rejected', message: 'browser' });
    await expect(call('luma_get_guests', { event: 'evt-abc' })).rejects.toThrow(`luma_get_guests: ${LUMA_KEY_REJECTED_MESSAGE}.`);
    // The route's own refusal (success: false) carries its words.
    mockFetch.mockResolvedValueOnce({ success: false, connected: false, message: LUMA_NOT_CONNECTED_MESSAGE });
    await expect(call('luma_list_events', {})).rejects.toThrow(/^luma_list_events: Luma is not connected/);
  });
});

describe('size caps and truncation', () => {
  it('a long transcript is cut at about 60 KB with truncated, total_turns and next_start_turn; start_turn reads on', async () => {
    const turns = Array.from({ length: 2000 }, (_, i) => ({ speaker: `S${i % 3}`, text: `turn ${i} ${'w'.repeat(100)}`, start_time: i }));
    mockFetch.mockResolvedValue({ success: true, recording_id: 7, transcript: turns });
    const r1 = await call('fathom_get_transcript', { recording_id: 7 });
    expect(answerBytes(r1)).toBeLessThanOrEqual(MAX_ANSWER_BYTES);
    const a = parse(r1);
    expect(a.truncated).toBe(true);
    expect(a.total_turns).toBe(2000);
    expect(a.count).toBeGreaterThan(100);
    expect(a.count).toBeLessThan(2000);
    expect(a.next_start_turn).toBe(a.count);
    expect(a.transcript[0].text).toMatch(/^turn 0 /);
    const r2 = await call('fathom_get_transcript', { recording_id: 7, start_turn: a.next_start_turn });
    const b = parse(r2);
    expect(b.start_turn).toBe(a.count);
    expect(b.transcript[0].text).toMatch(new RegExp(`^turn ${a.count} `));
    expect(mockFetch.mock.calls[1][0].body).toStrictEqual({ recording_id: 7 });
    const r3 = await call('fathom_get_transcript', { recording_id: 7, start_turn: 1990 });
    const c = parse(r3);
    expect(c).toMatchObject({ count: 10, start_turn: 1990, total_turns: 2000 });
    expect(c.truncated).toBeUndefined();
    expect(c.next_start_turn).toBeUndefined();
  });

  it('one huge turn is cut at its own limit and still answered', async () => {
    mockFetch.mockResolvedValueOnce({ success: true, transcript: [{ speaker: 'A', text: 'z'.repeat(100_000), start_time: 0 }] });
    const a = parse(await call('fathom_get_transcript', { recording_id: 1 }));
    expect(a.count).toBe(1);
    expect(a.transcript[0].text).toBe(`${'z'.repeat(MAX_TURN_TEXT_CHARS)}… [cut at ${MAX_TURN_TEXT_CHARS} characters]`);
  });

  it('many meetings with long summaries: summaries cut, the list cut to about 60 KB with truncated and a note; limit returns fewer', async () => {
    const meetings = Array.from({ length: 200 }, (_, i) => ({ recording_id: i + 1, title: `M${i}`, summary: 's'.repeat(5000), participants: [], action_items: [] }));
    mockFetch.mockResolvedValue({ success: true, meetings });
    const r = await call('fathom_get_meetings', {});
    expect(answerBytes(r)).toBeLessThanOrEqual(MAX_ANSWER_BYTES);
    const a = parse(r);
    expect(a).toMatchObject({ total: 200, truncated: true });
    expect(a.truncated_note).toMatch(/narrow created_after/);
    expect(a.meetings.length).toBe(a.count);
    expect(a.meetings[0].summary.length).toBeLessThan(MAX_SUMMARY_CHARS + 40);
    const few = parse(await call('fathom_get_meetings', { limit: 3 }));
    expect(few).toMatchObject({ total: 200, count: 3 });
    expect(few.truncated).toBeUndefined();
  });

  it('a Luma page that does not fit is cut, keeps its paging fields, and says to re-read with a smaller page', async () => {
    const guests = Array.from({ length: 60 }, (_, i) => ({ guest_id: `g${i}`, email: `g${i}@example.com`, name: 'n', registration_answers: Array.from({ length: 30 }, () => ({ label: 'L', value: 'v'.repeat(300) })) }));
    mockFetch.mockResolvedValueOnce({ success: true, calendar: 'C', event_id: 'evt-a', approval_status: 'approved', has_more: true, next_cursor: 'c9', guests });
    const r = await call('luma_get_guests', { event: 'evt-a', include_registration_answers: true });
    expect(answerBytes(r)).toBeLessThanOrEqual(MAX_ANSWER_BYTES);
    const a = parse(r);
    expect(a).toMatchObject({ truncated: true, has_more: true, next_cursor: 'c9' });
    expect(a.count).toBeLessThan(60);
    expect(a.truncated_note).toMatch(/same cursor \(or none\) and a smaller max_guests/);
  });
});

describe('errors', () => {
  it('a refusal (success: false) carries only the route\'s short message', async () => {
    mockFetch.mockResolvedValueOnce({ success: false, message: 'No Fathom account connected. Please connect your Fathom account in Settings → Connected Accounts to use this tool.', status: 401, stack: 'at x' });
    await expect(call('fathom_get_meetings', {})).rejects.toThrow(/^fathom_get_meetings: No Fathom account connected\. Please connect/);
    mockFetch.mockResolvedValueOnce({ success: false, message: 'Recording 5 not found for the connected Fathom account.', errorClass: 'invalid_args' });
    await expect(call('fathom_get_transcript', { recording_id: 5 })).rejects.toThrow('fathom_get_transcript: Recording 5 not found for the connected Fathom account.');
    mockFetch.mockResolvedValueOnce(undefined);
    await expect(call('luma_list_events', {})).rejects.toThrow('luma_list_events: the service gave no answer.');
  });

  it('a 4xx passes through as it is (quota, a refused body, a restricted caller)', async () => {
    for (const message of ['API error (429): Monthly token quota reached', 'API error (400): event is required', 'API error (403): Luma is not available to a shared-link visitor']) {
      mockFetch.mockRejectedValueOnce(new Error(message));
      await expect(call('luma_get_guests', { event: 'evt-a' })).rejects.toThrow(message);
    }
  });

  it('a 5xx or an unreachable route is a fixed text that never carries the internal detail', async () => {
    mockFetch.mockRejectedValueOnce(new Error('API error (500): The Fathom meetings could not be read at /var/app/current'));
    const e1 = await call('fathom_get_meetings', {}).catch((e: Error) => e);
    expect(e1.message).toBe('fathom_get_meetings: the service could not answer (HTTP 500). Try again later. Nothing was changed.');
    mockFetch.mockRejectedValueOnce(new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:3001'));
    const e2 = await call('fathom_get_transcript', { recording_id: 1 }).catch((e: Error) => e);
    expect(e2.message).toBe('fathom_get_transcript: the service could not be reached or did not answer in time. Try again later. Nothing was changed.');
  });
});

describe('guards', () => {
  it('caps per tool: Fathom 4 at a time / 30 an hour, Luma events 4 / 60, Luma guests 4 / 30', () => {
    expect([GUARDS.fathom_get_meetings.processMax, GUARDS.fathom_get_meetings.perHour]).toEqual([4, 30]);
    expect([GUARDS.fathom_get_transcript.processMax, GUARDS.fathom_get_transcript.perHour]).toEqual([4, 30]);
    expect([GUARDS.luma_list_events.processMax, GUARDS.luma_list_events.perHour]).toEqual([4, 60]);
    expect([GUARDS.luma_get_guests.processMax, GUARDS.luma_get_guests.perHour]).toEqual([4, 30]);
  });

  it('one call at a time per caller, a process cap across callers, and the slot is freed after a failure', async () => {
    let release!: (v: unknown) => void;
    mockFetch.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = call('luma_list_events', {}, 'u1');
    await expect(call('luma_list_events', {}, 'u1')).rejects.toThrow(/another call of yours to this tool is still running/);
    // another tool is its own guard
    mockFetch.mockResolvedValueOnce({ success: true, guests: [] });
    await expect(call('luma_get_guests', { event: 'evt-a' }, 'u1')).resolves.toBeDefined();
    const pending: Array<(v: unknown) => void> = [];
    mockFetch.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
    const others = ['u2', 'u3', 'u4'].map((u) => call('luma_list_events', {}, u));
    await expect(call('luma_list_events', {}, 'u5')).rejects.toThrow(/this tool is busy/);
    release({ success: true, events: [] });
    pending.forEach((r) => r({ success: true, events: [] }));
    await Promise.all([first, ...others]);
    expect(GUARDS.luma_list_events.inFlight).toBe(0);
    mockFetch.mockReset();
    mockFetch.mockRejectedValueOnce(new Error('API error (502): bad gateway'));
    await expect(call('luma_list_events', {}, 'u1')).rejects.toThrow(/HTTP 502/);
    expect(GUARDS.luma_list_events.callers.has('u1')).toBe(false);
  });

  it('an hourly cap per caller: the next call is refused before anything is called; another caller is not affected', async () => {
    mockFetch.mockResolvedValue({ success: true, meetings: [] });
    for (let i = 0; i < 30; i++) await call('fathom_get_meetings', {}, 'heavy');
    await expect(call('fathom_get_meetings', {}, 'heavy')).rejects.toThrow(/you have made 30 calls to this tool in the last hour/);
    expect(mockFetch).toHaveBeenCalledTimes(30);
    await expect(call('fathom_get_meetings', {}, 'light')).resolves.toBeDefined();
  });

  it('a refused argument does not use up a call', async () => {
    for (let i = 0; i < 40; i++) await expect(call('fathom_get_transcript', { recording_id: 'x' }, 'u9')).rejects.toThrow(/recording_id/);
    expect(GUARDS.fathom_get_transcript.recent.get('u9')).toBeUndefined();
  });
});
