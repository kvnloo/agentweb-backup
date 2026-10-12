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
import { LumaApiService, parseLumaEventId } from '../services/lumaApiService';

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
    expect(JSON.stringify(res.body)).not.toContain('secret-key');
  });

  it('does not save a key Luma rejects', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 401 }));
    const res = await request(app).post('/api/oauth/luma/connect').send({ api_key: 'bad' });
    expect(res.status).toBe(401);
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
        entries: [guest('a', '2026-10-06T00:00:00Z'), guest('ghost', null), guest('old', '2026-09-01T00:00:00Z')],
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
  });

  it('keeps unregistered records only when the invited status is requested', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ entries: [guest('inv', null, 'invited')], has_more: false }));
    const page = await svc.listGuests({ eventId: 'evt-1', approvalStatus: 'invited', maxGuests: 10 });
    expect(page.guests).toHaveLength(1);
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
