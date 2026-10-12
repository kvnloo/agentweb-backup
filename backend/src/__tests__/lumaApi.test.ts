/**
 * ENG-2338 — Luma API connection: credential handling, page-resume integrity,
 * and tool gating. fetch and the DB layer are mocked; nothing hits Luma.
 */
import request from 'supertest';
import express from 'express';

process.env.JWT_SECRET = 'test-jwt-secret-for-testing';

const mockCreateAccount = jest.fn();
const mockGetAccounts = jest.fn();
const mockUpdateAccountConfig = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/connectedAccountsDb', () => ({
  createAccount: (...a: any[]) => mockCreateAccount(...a),
  getAccountsWithOwnerIncludingOrgShared: (...a: any[]) => mockGetAccounts(...a),
  updateAccountConfig: (...a: any[]) => mockUpdateAccountConfig(...a),
}));

jest.mock('../utils/crypto', () => ({
  encryptPassword: (p: string, u: string) => `enc(${u}):${p}`,
  decryptPassword: (e: string) => ({ password: e.replace(/^enc\([^)]*\):/, ''), userId: 'owner' }),
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1', email: 'u@example.com' };
    next();
  },
}));

import lumaAuthRouter from '../routes/lumaAuth';
import { emmaToolRegistry } from '../emma/registry';
import '../emma/lumaTools';
import { LumaApiService, parseLumaEventId, normalizeIsoUtc } from '../services/lumaApiService';

const fetchMock = jest.fn();
(global as any).fetch = fetchMock;

const jsonResponse = (body: any, init: { status?: number; headers?: Record<string, string> } = {}) => ({
  ok: (init.status ?? 200) < 400,
  status: init.status ?? 200,
  headers: { get: (k: string) => init.headers?.[k.toLowerCase()] ?? null },
  json: async () => body,
});

const guest = (id: string, registeredAt: string | null, status = 'approved') => ({
  id,
  user_email: `${id}@example.com`,
  user_name: id,
  user_first_name: id,
  user_last_name: null,
  approval_status: status,
  registered_at: registeredAt,
  phone_number: null,
  registration_answers: null,
});

const tool = (name: string) => emmaToolRegistry.getTool(name)!.execute;
const lumaAccount = (over: any = {}) => ({
  platform: 'luma',
  account_id: 'cal-1',
  account_name: 'ThinkingAI',
  userId: 'owner',
  config: { account_type: 'api_key', access_token: 'enc(owner):secret-key', token_expires_at: Number.MAX_SAFE_INTEGER },
  ...over,
});

beforeEach(() => {
  fetchMock.mockReset();
  mockCreateAccount.mockReset();
  mockGetAccounts.mockReset();
  mockUpdateAccountConfig.mockClear();
});

describe('parseLumaEventId', () => {
  it('takes a bare id and the id out of a manage URL', () => {
    expect(parseLumaEventId('evt-oxHprLhYPH3C7HS')).toBe('evt-oxHprLhYPH3C7HS');
    expect(parseLumaEventId('https://luma.com/event/manage/evt-oxHprLhYPH3C7HS/guests')).toBe('evt-oxHprLhYPH3C7HS');
    expect(parseLumaEventId('https://luma.com/some-slug')).toBeNull();
  });
});

describe('POST /connect', () => {
  const app = express().use(express.json()).use('/api/oauth/luma', lumaAuthRouter);

  it('validates the key with Luma, stores it ENCRYPTED, and never echoes it back', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'cal-1', name: 'ThinkingAI', url: 'https://luma.com/thinkingai' }));
    mockCreateAccount.mockImplementation(async (_u, _p, input) => ({ platform: 'luma', ...input }));

    const res = await request(app).post('/api/oauth/luma/connect').send({ api_key: '  secret-key ' });

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][1].headers['x-luma-api-key']).toBe('secret-key');
    const stored = mockCreateAccount.mock.calls[0][2];
    expect(stored.account_id).toBe('cal-1');
    expect(stored.config.access_token).toBe('enc(user-1):secret-key');
    expect(stored.config.token_expires_at).toBe(9999999999999);
    expect(stored.config.needs_reconnect).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('secret-key');
  });

  it('does not save a key Luma rejects', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 401 }));
    const res = await request(app).post('/api/oauth/luma/connect').send({ api_key: 'bad' });
    expect(res.status).toBe(422);
    expect(mockCreateAccount).not.toHaveBeenCalled();
  });

  it('rejects an empty key without calling Luma', async () => {
    const res = await request(app).post('/api/oauth/luma/connect').send({});
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('LumaApiService.listGuests', () => {
  const svc = new LumaApiService('k');

  it('drops invited-but-unregistered records and stops paging at the lookback cutoff', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        entries: [guest('a', '2026-10-06T00:00:00Z'), guest('old', '2026-09-01T00:00:00Z'), guest('ghost', null)],
        has_more: true,
        next_cursor: 'c2',
      }),
    );
    const page = await svc.listGuests({ eventId: 'evt-1', registeredAfter: '2026-10-01T00:00:00Z', maxGuests: 200 });

    expect(page.guests.map((g) => g.guest_id)).toEqual(['a']);
    expect(page.has_more).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never splits a page, so the returned cursor resumes exactly where the read stopped', async () => {
    const full = Array.from({ length: 100 }, (_, i) => guest(`g${i}`, '2026-10-06T00:00:00Z'));
    fetchMock.mockResolvedValueOnce(jsonResponse({ entries: full, has_more: true, next_cursor: 'c2' }));

    const page = await svc.listGuests({ eventId: 'evt-1', maxGuests: 10 });

    expect(page.guests).toHaveLength(100);
    expect(page.has_more).toBe(true);
    expect(page.next_cursor).toBe('c2');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('pagination_limit=10');
  });

  it('keeps unregistered records only when the invited status is requested', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ entries: [guest('inv', null, 'invited')], has_more: false }));
    const page = await svc.listGuests({ eventId: 'evt-1', approvalStatus: 'invited', maxGuests: 10 });
    expect(page.guests).toHaveLength(1);
  });
});

describe('LumaApiService.listGuests — paging and failure edges', () => {
  const svc = new LumaApiService('k');
  const page = (ids: string[], more: boolean, cursor?: string) =>
    jsonResponse({ entries: ids.map((i) => guest(i, '2026-10-06T00:00:00Z')), has_more: more, next_cursor: cursor });

  it('follows next_cursor across pages until maxGuests is met, then hands back the resume cursor', async () => {
    fetchMock.mockResolvedValueOnce(page(['a', 'b'], true, 'c2')).mockResolvedValueOnce(page(['c'], true, 'c3'));
    const r = await svc.listGuests({ eventId: 'evt-1', maxGuests: 3 });
    expect(r.guests.map((g) => g.guest_id)).toEqual(['a', 'b', 'c']);
    expect(String(fetchMock.mock.calls[1][0])).toContain('pagination_cursor=c2');
    expect(r.has_more).toBe(true);
    expect(r.next_cursor).toBe('c3');
  });

  it('treats has_more without a cursor as finished instead of re-reading page one', async () => {
    fetchMock.mockResolvedValueOnce(page(['a'], true, undefined));
    const r = await svc.listGuests({ eventId: 'evt-1', maxGuests: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.has_more).toBe(false);
  });

  it('keeps earlier pages when a later one is rate-limited, resuming at the failed page', async () => {
    fetchMock.mockResolvedValueOnce(page(['a'], true, 'c2')).mockResolvedValueOnce(jsonResponse({}, { status: 429 }));
    const r = await svc.listGuests({ eventId: 'evt-1', maxGuests: 500 });
    expect(r.guests.map((g) => g.guest_id)).toEqual(['a']);
    expect(r.has_more).toBe(true);
    expect(r.next_cursor).toBe('c2');
    expect(r.interrupted).toMatch(/429/);
  });

  it('still throws when the very first page fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 429 }));
    await expect(svc.listGuests({ eventId: 'evt-1', maxGuests: 10 })).rejects.toThrow(/429/);
  });

  it('ignores the registered_after cutoff for invited guests, who have no registration time', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ entries: [guest('old', '2020-01-01T00:00:00Z', 'invited'), guest('ghost', null, 'invited')], has_more: false }),
    );
    const r = await svc.listGuests({
      eventId: 'evt-1',
      approvalStatus: 'invited',
      registeredAfter: '2026-10-01T00:00:00Z',
      maxGuests: 10,
    });
    expect(r.guests.map((g) => g.guest_id)).toEqual(['old', 'ghost']);
  });
});

describe('normalizeIsoUtc', () => {
  it('reads bare dates and offset-less datetimes as UTC, and keeps explicit offsets', () => {
    expect(normalizeIsoUtc('2026-10-01')).toBe('2026-10-01T00:00:00.000Z');
    expect(normalizeIsoUtc('2026-10-01T12:30')).toBe('2026-10-01T12:30:00.000Z');
    expect(normalizeIsoUtc('2026-10-01T12:30:00+02:00')).toBe('2026-10-01T10:30:00.000Z');
    expect(normalizeIsoUtc('yesterday')).toBeNull();
    expect(normalizeIsoUtc('')).toBeNull();
  });
});

describe('LumaApiService — events and the page ceiling', () => {
  const svc = new LumaApiService('k');

  it('maps events to flat summaries', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        entries: [{ id: 'evt-1', name: 'Launch', start_at: '2026-10-10T00:00:00Z', end_at: null, timezone: 'UTC', url: 'https://luma.com/launch', extra: 'x' }],
        has_more: false,
      }),
    );
    const r = await svc.listEvents({ limit: 500 });
    expect(r.events).toEqual([{ event_id: 'evt-1', name: 'Launch', start_at: '2026-10-10T00:00:00Z', end_at: null, timezone: 'UTC', url: 'https://luma.com/launch' }]);
    expect(String(fetchMock.mock.calls[0][0])).toContain('pagination_limit=100');
  });

  it('stops at the page ceiling and reports there is more, with a cursor to resume', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ entries: [guest(`g${fetchMock.mock.calls.length}`, '2026-10-06T00:00:00Z')], has_more: true, next_cursor: `c${fetchMock.mock.calls.length}` }),
    );
    const r = await svc.listGuests({ eventId: 'evt-1', maxGuests: 100000 });
    expect(fetchMock).toHaveBeenCalledTimes(25);
    expect(r.has_more).toBe(true);
    expect(r.next_cursor).toBe('c25');
    fetchMock.mockReset();
  });
});

describe('luma tools', () => {
  it('say so, with the fallback, when no key is connected', async () => {
    mockGetAccounts.mockResolvedValue([]);
    const r: any = await tool('luma_get_guests')({ event: 'evt-1' }, { userId: 'user-1' });
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/No Luma API key is connected/);
    expect(r.message).toMatch(/fall back/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolve org-shared accounts via the same scope list_connected_accounts uses, and decrypt the key', async () => {
    mockGetAccounts.mockResolvedValue([lumaAccount()]);
    fetchMock.mockResolvedValueOnce(jsonResponse({ entries: [guest('a', '2026-10-06T00:00:00Z')], has_more: false }));

    const r: any = await tool('luma_get_guests')(
      { event: 'https://luma.com/event/manage/evt-abc123/guests', registered_after: '2026-10-01T00:00:00Z' },
      { userId: 'user-1' },
    );

    expect(mockGetAccounts).toHaveBeenCalledWith('user-1');
    expect(fetchMock.mock.calls[0][1].headers['x-luma-api-key']).toBe('secret-key');
    expect(String(fetchMock.mock.calls[0][0])).toContain('event_id=evt-abc123');
    expect(r.success).toBe(true);
    expect(r.guests).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain('secret-key');
  });

  it('omits null fields and registration answers by default, includes answers when asked', async () => {
    mockGetAccounts.mockResolvedValue([lumaAccount()]);
    const entry = { ...guest('a', '2026-10-06T00:00:00Z'), registration_answers: [{ label: 'Role', answer: 'CMO' }] };
    fetchMock.mockResolvedValue(jsonResponse({ entries: [entry], has_more: false }));

    const lean: any = await tool('luma_get_guests')({ event: 'evt-1' }, { userId: 'user-1' });
    expect(Object.keys(lean.guests[0]).sort()).toEqual(['approval_status', 'email', 'first_name', 'guest_id', 'name', 'registered_at']);

    const full: any = await tool('luma_get_guests')({ event: 'evt-1', include_registration_answers: true }, { userId: 'user-1' });
    expect(full.guests[0].registration_answers).toEqual([{ label: 'Role', answer: 'CMO' }]);
  });

  it('sends a bare registered_after date to Luma-side logic as an explicit UTC instant', async () => {
    mockGetAccounts.mockResolvedValue([lumaAccount()]);
    fetchMock.mockResolvedValue(jsonResponse({ entries: [guest('new', '2026-10-06T00:00:00Z'), guest('old', '2026-09-30T23:59:59Z')], has_more: true, next_cursor: 'c2' }));
    const r: any = await tool('luma_get_guests')({ event: 'evt-1', registered_after: '2026-10-01' }, { userId: 'user-1' });
    expect(r.guests.map((g: any) => g.guest_id)).toEqual(['new']);
    expect(r.has_more).toBe(false);
  });

  it('normalises list_events bounds before sending them to Luma', async () => {
    mockGetAccounts.mockResolvedValue([lumaAccount()]);
    fetchMock.mockResolvedValue(jsonResponse({ entries: [], has_more: false }));
    await tool('luma_list_events')({ after: '2026-10-01' }, { userId: 'user-1' });
    expect(decodeURIComponent(String(fetchMock.mock.calls[0][0]))).toContain('after=2026-10-01T00:00:00.000Z');
  });

  it('refuses to guess between several connected calendars', async () => {
    mockGetAccounts.mockResolvedValue([lumaAccount(), lumaAccount({ account_id: 'cal-2', account_name: 'Other' })]);
    const r: any = await tool('luma_list_events')({}, { userId: 'user-1' });
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/calendar_id/);
    expect(r.message).toContain('cal-2');
  });

  it('flags a rejected key as needing reconnect and points at the fallback', async () => {
    mockGetAccounts.mockResolvedValue([lumaAccount()]);
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 401 }));

    const r: any = await tool('luma_get_guests')({ event: 'evt-1' }, { userId: 'user-1' });

    expect(r.success).toBe(false);
    expect(mockUpdateAccountConfig).toHaveBeenCalledWith('owner', 'luma', 'cal-1', { needs_reconnect: true });
    expect(r.message).toMatch(/rejected the API key/);
  });

  it('does NOT flag the key dead when Luma answers 403 for one event', async () => {
    mockGetAccounts.mockResolvedValue([lumaAccount()]);
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 403 }));
    const r: any = await tool('luma_get_guests')({ event: 'evt-other' }, { userId: 'user-1' });
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/different calendar/);
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });

  it('tells the agent how to resolve a public slug link instead of failing opaquely', async () => {
    mockGetAccounts.mockResolvedValue([lumaAccount()]);
    const r: any = await tool('luma_get_guests')({ event: 'https://luma.com/my-event' }, { userId: 'user-1' });
    expect(r.message).toMatch(/luma_list_events/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric limit before calling Luma', async () => {
    mockGetAccounts.mockResolvedValue([lumaAccount()]);
    const r: any = await tool('luma_list_events')({ limit: 'lots' }, { userId: 'user-1' });
    expect(r.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a partial read with a resume cursor', async () => {
    mockGetAccounts.mockResolvedValue([lumaAccount()]);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ entries: [guest('a', '2026-10-06T00:00:00Z')], has_more: true, next_cursor: 'c2' }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 429 }));
    const r: any = await tool('luma_get_guests')({ event: 'evt-1', max_guests: 500 }, { userId: 'user-1' });
    expect(r.success).toBe(true);
    expect(r.next_cursor).toBe('c2');
    expect(r.interrupted).toMatch(/call again with next_cursor/);
  });

  it('does not call Luma again once an account is flagged needs_reconnect', async () => {
    mockGetAccounts.mockResolvedValue([lumaAccount({ config: { ...lumaAccount().config, needs_reconnect: true } })]);
    const r: any = await tool('luma_get_guests')({ event: 'evt-1' }, { userId: 'user-1' });
    expect(r.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a 429 with the retry window', async () => {
    mockGetAccounts.mockResolvedValue([lumaAccount()]);
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 429, headers: { 'retry-after': '42' } }));
    const r: any = await tool('luma_list_events')({}, { userId: 'user-1' });
    expect(r.message).toMatch(/Retry after 42s/);
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });
});
