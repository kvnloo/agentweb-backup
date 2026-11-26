/**
 * ENG-2840 (W2-7): `add_lead_engagement` for outside agents. What it sends to the route, every shape refused before anything is called
 * (type, data keys and values, size, date window, idempotency key), the hourly allowance, and how answers and failures read. No network:
 * the self-call is a double. The per-lead cap, the idempotency check and the tenant check live behind the route (their own tests).
 */
jest.mock('../httpClient', () => ({ mcpFetch: jest.fn() }));

import { mcpFetch } from '../httpClient';
import { mcpToolRegistry } from '../registry';
import {
  ENGAGEMENTS_PER_HOUR,
  EVENT_DATA_MAX_BYTES,
  RESERVED_DATA_KEYS,
  addEngagementRequest,
  engagementAnswer,
  engagementBudget,
} from '../leadEngagementTool';
import { MCP_TOOL_SIDE_EFFECTS } from '../toolAnnotationPolicy';

const mockFetch = mcpFetch as jest.Mock;
const ctxFor = (userId: string) => ({ userId, sessionId: 'sess-1', apiKeyId: 'key-1', externalMcp: true });
const call = (args: unknown, userId = 'user-1') => (mcpToolRegistry.getTool('add_lead_engagement') as any).execute(args, ctxFor(userId));
const base = { list_id: 'list_1', lead_id: 'lead_1', event_type: 'custom.phone_call' };
const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const parse = (result: any) => JSON.parse(result.content[0].text);

beforeEach(() => {
  mockFetch.mockReset();
  engagementBudget.reset();
});

describe('the request', () => {
  it('sends the ids and the type, and data, date and key only when given (the date normalised to UTC)', () => {
    expect(addEngagementRequest(base, NOW)).toEqual(base);
    expect(addEngagementRequest({ ...base, event_data: { duration_min: 12, outcome: 'booked a demo', followUp: true, note: null }, event_date: '2026-11-26T15:30:00+05:30', idempotency_key: 'call-2026-11-26-001' }, NOW)).toEqual({
      ...base,
      event_data: { duration_min: 12, outcome: 'booked a demo', followUp: true, note: null },
      event_date: '2026-11-26T10:00:00.000Z',
      idempotency_key: 'call-2026-11-26-001',
    });
  });

  it('refuses any other argument by name (identity, channel, or the stored fields)', () => {
    for (const extra of ['user_id', 'channel', 'eventData', 'createdAt', 'max_events']) {
      expect(() => addEngagementRequest({ ...base, [extra]: 'x' }, NOW)).toThrow(new RegExp(`"${extra}" is not an input of add_lead_engagement`));
    }
  });

  it('event_type must be custom. plus a short lowercase name', () => {
    for (const ok of ['custom.a', 'custom.phone_call', 'custom.meeting.v2', `custom.${'a'.repeat(53)}`]) {
      expect(() => addEngagementRequest({ ...base, event_type: ok }, NOW)).not.toThrow();
    }
    for (const bad of [undefined, '', 'phone_call', 'status.changed', 'email.received', 'custom.', 'custom.Phone', 'custom._x', `custom.${'a'.repeat(54)}`, 'custom.a b', 'custom.a/b', 7]) {
      expect(() => addEngagementRequest({ ...base, event_type: bad }, NOW)).toThrow(/event_type must be "custom\."/);
    }
  });

  it('refuses every reserved data key, whatever its case', () => {
    expect(RESERVED_DATA_KEYS.has('smartleadeventkey')).toBe(true);
    for (const key of ['smartleadEventKey', 'SMARTLEADEVENTKEY', 'from', 'To', 'subject', 'message', 'content', 'platform', 'reason', 'source', 'linkedin', 'campaignId', 'accountId', 'invitationId', 'channel', 'idempotencyKey', 'eventId', 'eventType', 'createdAt']) {
      expect(() => addEngagementRequest({ ...base, event_data: { [key]: 'x' } }, NOW)).toThrow(/is reserved/);
    }
  });

  it('data is a plain object of at most 20 simple values with plain keys', () => {
    const tooMany = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i]));
    const cases: Array<[unknown, RegExp]> = [
      [[1, 2], /must be an object/],
      ['text', /must be an object/],
      [new Date(), /must be an object/],
      [tooMany, /21 keys; at most 20/],
      [{ 'bad key': 1 }, /key "bad key" is not allowed/],
      [{ _x: 1 }, /is not allowed/],
      [{ __proto__x: 1 }, /is not allowed/],
      [{ nested: { a: 1 } }, /no nested objects or lists/],
      [{ list: [1] }, /no nested objects or lists/],
      [{ n: Number.POSITIVE_INFINITY }, /finite number/],
      [{ t: 'a'.repeat(501) }, /at most 500 characters/],
      [{ t: `a${String.fromCharCode(0x202e)}b` }, /no control or invisible characters/],
      [{ t: `a${String.fromCharCode(7)}b` }, /no control or invisible characters/],
    ];
    for (const [event_data, message] of cases) {
      expect(() => addEngagementRequest({ ...base, event_data }, NOW)).toThrow(message);
    }
    expect(() => addEngagementRequest({ ...base, event_data: { t: 'line one\nline two\tend' } }, NOW)).not.toThrow();
  });

  it('refuses data keys the public schemas may not carry (transcripts, locations, IP addresses)', () => {
    for (const key of ['transcript', 'full_transcript', 'conversation_history', 'location', 'latitude', 'lng', 'ip_address', 'ip']) {
      expect(() => addEngagementRequest({ ...base, event_data: { [key]: 'x' } }, NOW)).toThrow(/is not accepted: transcripts, locations and IP addresses/);
    }
  });

  it(`the whole data is at most ${EVENT_DATA_MAX_BYTES} bytes`, () => {
    const big = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`, 'é'.repeat(250)]));
    expect(() => addEngagementRequest({ ...base, event_data: big }, NOW)).toThrow(/bytes; at most 2048/);
  });

  it('event_date: ISO with a zone, real, not ahead by more than 5 minutes, not more than a year back', () => {
    expect(() => addEngagementRequest({ ...base, event_date: '2026-11-26T12:04:00Z' }, NOW)).not.toThrow();
    expect(() => addEngagementRequest({ ...base, event_date: '2025-11-26T00:00:00Z' }, NOW)).not.toThrow();
    expect(() => addEngagementRequest({ ...base, event_date: '2026-11-26T12:06:00Z' }, NOW)).toThrow(/in the future/);
    expect(() => addEngagementRequest({ ...base, event_date: '2025-11-24T00:00:00Z' }, NOW)).toThrow(/more than a year ago/);
    for (const bad of ['2026-11-26', '2026-11-26T12:00:00', 'yesterday', '2026-13-40T99:99:00Z', 1764158400000]) {
      expect(() => addEngagementRequest({ ...base, event_date: bad }, NOW)).toThrow(/event_date/);
    }
  });

  it('idempotency_key must not carry the words that mark a lead engaged', () => {
    for (const key of ['replied-12345', 'call-CLICKED-01', 'received_2026_11']) {
      expect(() => addEngagementRequest({ ...base, idempotency_key: key }, NOW)).toThrow(/must not contain the words clicked, replied or received/);
    }
  });

  it('idempotency_key is 8 to 64 letters, digits, - or _', () => {
    for (const bad of ['short', 'a'.repeat(65), 'has space1', 'semi;colon', 12345678]) {
      expect(() => addEngagementRequest({ ...base, idempotency_key: bad }, NOW)).toThrow(/idempotency_key must be/);
    }
  });

  it('ids: text, no padding or control characters, at most 200 characters', () => {
    for (const bad of [undefined, '', ' list', 'a'.repeat(201), `a${String.fromCharCode(10)}b`, 5]) {
      expect(() => addEngagementRequest({ ...base, list_id: bad }, NOW)).toThrow(/list_id/);
    }
  });

  it('every refusal says nothing was recorded, and nothing is called', async () => {
    await expect(call({ ...base, event_type: 'email.received' })).rejects.toThrow(/Nothing was recorded\.$/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('calling the route', () => {
  it('posts to the add-lead-engagement route and answers with fixed fields', async () => {
    mockFetch.mockResolvedValueOnce({ success: true, recorded: true, message: 'Engagement "custom.phone_call" recorded for Ada Lovelace', eventType: 'custom.phone_call', leadName: 'Ada Lovelace', debug: 'x' });
    const answer = parse(await call(base));
    expect(mockFetch).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', path: '/api/emma/add-lead-engagement', body: base }));
    expect(answer).toEqual({ success: true, recorded: true, event_type: 'custom.phone_call', lead_name: 'Ada Lovelace', message: 'Engagement "custom.phone_call" recorded for Ada Lovelace' });
  });

  it('a duplicate key is a success that recorded nothing', () => {
    expect(engagementAnswer({ success: true, recorded: false, duplicate: true, message: 'already', eventType: 'custom.x', leadName: 'A' })).toMatchObject({ success: true, recorded: false, duplicate: true });
  });

  it('a refusal from the route is an error with its message only (never its raw error)', async () => {
    mockFetch.mockResolvedValueOnce({ success: false, message: 'This lead already holds 50 events recorded by outside agents, the most it takes. Nothing was recorded.', error: 'stack' });
    await expect(call(base)).rejects.toThrow(/holds 50 events/);
    mockFetch.mockResolvedValueOnce({ success: false, message: 'Access denied', error: 'You need CRM editor access' });
    await expect(call(base)).rejects.toThrow(/^add_lead_engagement: Access denied\.$/);
  });

  it('a 4xx passes through; a 5xx or no answer says the event may or may not be recorded, and how to check', async () => {
    mockFetch.mockRejectedValueOnce(new Error('API error (400): event_type is required'));
    await expect(call(base)).rejects.toThrow('API error (400): event_type is required');
    mockFetch.mockRejectedValueOnce(new Error('API error (500): ConditionalCheckFailed at /srv/x'));
    await expect(call(base)).rejects.toThrow(/could not answer \(HTTP 500\), so the event may or may not have been recorded\. Check with get_lead_engagements/);
    mockFetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    await expect(call({ ...base, idempotency_key: 'retry-key-0001' })).rejects.toThrow(/could not be reached.*retry with the same idempotency_key/);
    await expect(Promise.resolve().then(() => engagementAnswer('nope'))).rejects.toThrow(/may not have been recorded/);
  });
});

describe('the hourly allowance', () => {
  it(`${ENGAGEMENTS_PER_HOUR} calls an hour per caller, then a refusal with the wait; other callers unaffected; the window slides`, () => {
    const t0 = NOW;
    for (let i = 0; i < ENGAGEMENTS_PER_HOUR; i++) expect(engagementBudget.take('user-1', t0 + i)).toBe(0);
    expect(engagementBudget.take('user-1', t0 + 1000)).toBe(3599);
    expect(engagementBudget.take('user-2', t0 + 1000)).toBe(0);
    expect(engagementBudget.take('user-1', t0 + 60 * 60_000 + 1)).toBe(0);
  });

  it('a call over the allowance is refused before the route', async () => {
    for (let i = 0; i < ENGAGEMENTS_PER_HOUR; i++) engagementBudget.take('user-9');
    await expect(call(base, 'user-9')).rejects.toThrow(/recorded 120 events in the last hour/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('registration', () => {
  it('is a write tool that needs a user account (tools:execute), with exact inputs', () => {
    const tool = mcpToolRegistry.getTool('add_lead_engagement') as any;
    expect(tool.readOnly).toBeFalsy();
    expect(tool.requiresUserAccount).toBe(true);
    expect(MCP_TOOL_SIDE_EFFECTS.add_lead_engagement).toBe('write');
    expect(Object.keys(tool.definition.inputSchema.properties).sort()).toEqual(['event_data', 'event_date', 'event_type', 'idempotency_key', 'lead_id', 'list_id']);
    expect(tool.definition.inputSchema.required).toEqual(['list_id', 'lead_id', 'event_type']);
  });
});
