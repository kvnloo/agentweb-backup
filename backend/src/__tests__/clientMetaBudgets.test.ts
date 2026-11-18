/**
 * ENG-3069: admin read of one managed customer's Meta budgets and spend for an exact window.
 * All Meta and DB access is mocked; no live Graph call.
 */
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(), getUserByEmail: jest.fn(), getAllUsers: jest.fn() },
}));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserId: jest.fn() }));
jest.mock('../services/spendProjectionDb', () => ({ getProjectionsBatch: jest.fn() }));
jest.mock('../utils/secretsManager', () => ({ getMetaAccessToken: jest.fn().mockResolvedValue('shared-token') }));
jest.mock('../utils/metaApiFetch', () => ({ fetchWithRetryAndPaging: jest.fn() }));
jest.mock('../services/metaTokenRefresh', () => ({
  ensureFreshMetaAdAccountToken: jest.fn().mockResolvedValue({ attempted: false, refreshed: false }),
}));

import { readClientMetaBudgets } from '../services/clientMetaBudgetsService';
import { fetchWithRetryAndPaging } from '../utils/metaApiFetch';
import { getMetaAccessToken } from '../utils/secretsManager';

const { userDb } = require('../services/db');
const { getAccountsByUserId } = require('../services/connectedAccountsDb');
const metaFetch = fetchWithRetryAndPaging as jest.Mock;

const client = { userId: 'client-1', email: 'owner@haven.com', displayName: 'Haven Owner' };
const ownAccount = {
  platform: 'meta',
  config: { account_type: 'ad_account', ad_account_id: '111', access_token: 'client-token' },
};

function graphRouter(overrides: Record<string, any> = {}) {
  metaFetch.mockImplementation(async (url: string) => {
    for (const [k, v] of Object.entries(overrides)) if (url.includes(k)) return typeof v === 'function' ? v() : v;
    if (url.includes('/act_111/insights')) return { data: [{ spend: '412.50', account_currency: 'USD' }] };
    if (url.includes('/act_111/campaigns')) {
      return { data: [{ id: 'c1', name: 'Leads', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '5000', insights: { data: [{ spend: '300.00' }] } }] };
    }
    if (url.includes('/act_111/adsets')) {
      return { data: [
        { id: 's1', name: 'Set A', campaign_id: 'c1', status: 'ACTIVE', effective_status: 'ACTIVE', lifetime_budget: '90000', insights: { data: [{ spend: '112.50' }] } },
        { id: 's2', name: 'Set B', campaign_id: 'c1', status: 'PAUSED', effective_status: 'PAUSED' },
      ] };
    }
    throw new Error(`unexpected url ${url}`);
  });
}

const admin = () => (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'admin', isAdmin: true });

describe('ENG-3069 readClientMetaBudgets', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (userDb.getUserByEmail as jest.Mock).mockResolvedValue(undefined);
    (userDb.getAllUsers as jest.Mock).mockResolvedValue([]);
  });

  it('happy path: reads the customer\'s own account with its own token and reports window spend and budgets', async () => {
    admin();
    (userDb.getUserByEmail as jest.Mock).mockResolvedValue(client);
    (getAccountsByUserId as jest.Mock).mockResolvedValue([ownAccount]);
    graphRouter();

    const r = await readClientMetaBudgets('admin', 'owner@haven.com', '2026-11-01', '2026-11-15');

    expect(r.success).toBe(true);
    expect(r.ad_account_id).toBe('111');
    expect(r.credential_source).toBe('client_connection');
    expect(r.client.email).toBe('owner@haven.com');
    expect(r.since).toBe('2026-11-01');
    expect(r.until).toBe('2026-11-15');
    expect(r.account_spend).toBe('412.50');
    expect(r.currency).toBe('USD');
    expect(r.campaigns).toEqual([
      { id: 'c1', name: 'Leads', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '5000', lifetime_budget: null, spend: '300.00' },
    ]);
    expect(r.ad_sets).toEqual([
      { id: 's1', name: 'Set A', campaign_id: 'c1', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: null, lifetime_budget: '90000', spend: '112.50' },
      { id: 's2', name: 'Set B', campaign_id: 'c1', status: 'PAUSED', effective_status: 'PAUSED', daily_budget: null, lifetime_budget: null, spend: '0' },
    ]);
    const urls = metaFetch.mock.calls.map((c) => c[0] as string);
    expect(urls.every((u) => u.includes('access_token=client-token'))).toBe(true);
    expect(urls.every((u) => u.includes(encodeURIComponent('{"since":"2026-11-01","until":"2026-11-15"}')))).toBe(true);
    expect(getMetaAccessToken).not.toHaveBeenCalled();
  });

  it('refuses a non-admin caller without reading anything', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'u', isAdmin: false });
    const r = await readClientMetaBudgets('u', 'owner@haven.com', '2026-11-01', '2026-11-15');
    expect(r.success).toBe(false);
    expect(r.error).toBe('Admin access required');
    expect(userDb.getUserByEmail).not.toHaveBeenCalled();
    expect(metaFetch).not.toHaveBeenCalled();
  });

  it('refuses a name that matches more than one client and names how many matched', async () => {
    admin();
    (userDb.getAllUsers as jest.Mock).mockResolvedValue([
      { userId: 'a', email: 'a@haven.com', displayName: 'Haven East' },
      { userId: 'b', email: 'b@haven.com', displayName: 'Haven West' },
    ]);
    const r = await readClientMetaBudgets('admin', 'haven', '2026-11-01', '2026-11-15');
    expect(r.success).toBe(false);
    expect(r.reason).toBe('ambiguous_client');
    expect(r.matches.map((m: any) => m.email)).toEqual(['a@haven.com', 'b@haven.com']);
    expect(getAccountsByUserId).not.toHaveBeenCalled();
    expect(metaFetch).not.toHaveBeenCalled();
  });

  it('refuses a customer with no usable Meta connection', async () => {
    admin();
    (userDb.getUserByEmail as jest.Mock).mockResolvedValue(client);
    (getAccountsByUserId as jest.Mock).mockResolvedValue([]);
    const r = await readClientMetaBudgets('admin', 'owner@haven.com', '2026-11-01', '2026-11-15');
    expect(r.success).toBe(false);
    expect(r.reason).toBe('no_meta_connection');
    expect(metaFetch).not.toHaveBeenCalled();
  });

  it('refuses a connected account id that has no token of its own (never pairs it with the shared token)', async () => {
    admin();
    (userDb.getUserByEmail as jest.Mock).mockResolvedValue(client);
    (getAccountsByUserId as jest.Mock).mockResolvedValue([
      { platform: 'meta', config: { account_type: 'ad_account', ad_account_id: '111' } }, // no token of its own
    ]);
    const r = await readClientMetaBudgets('admin', 'owner@haven.com', '2026-11-01', '2026-11-15');
    expect(r.success).toBe(false);
    expect(r.reason).toBe('credential_pair_mismatch');
    expect(getMetaAccessToken).not.toHaveBeenCalled();
    expect(metaFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['a Graph error body', { error: { message: 'Invalid OAuth access token', code: 190 } }],
    ['a truncated page set', { data: [], pagingTruncated: true }],
  ])('reports a Meta read failure (%s) as a failure, never as zero spend', async (_label, body) => {
    admin();
    (userDb.getUserByEmail as jest.Mock).mockResolvedValue(client);
    (getAccountsByUserId as jest.Mock).mockResolvedValue([ownAccount]);
    graphRouter({ '/act_111/adsets': body });
    const r = await readClientMetaBudgets('admin', 'owner@haven.com', '2026-11-01', '2026-11-15');
    expect(r.success).toBe(false);
    expect(r.reason).toBe('meta_read_failed');
    expect(r).not.toHaveProperty('account_spend');
    expect(r).not.toHaveProperty('campaigns');
  });

  it('reports a refused campaigns read that arrives as a non-2xx body with no error field as a failure', async () => {
    admin();
    (userDb.getUserByEmail as jest.Mock).mockResolvedValue(client);
    (getAccountsByUserId as jest.Mock).mockResolvedValue([ownAccount]);
    const refused: any = { data: [] };
    Object.defineProperty(refused, '__httpStatus', { value: 400, enumerable: false });
    graphRouter({ '/act_111/campaigns': refused });
    const r = await readClientMetaBudgets('admin', 'owner@haven.com', '2026-11-01', '2026-11-15');
    expect(r.success).toBe(false);
    expect(r.reason).toBe('meta_read_failed');
    expect(r).not.toHaveProperty('account_spend');
  });

  it('reports a thrown Meta fetch as a failure', async () => {
    admin();
    (userDb.getUserByEmail as jest.Mock).mockResolvedValue(client);
    (getAccountsByUserId as jest.Mock).mockResolvedValue([ownAccount]);
    graphRouter({ '/act_111/insights': () => { throw new Error('ECONNRESET'); } });
    const r = await readClientMetaBudgets('admin', 'owner@haven.com', '2026-11-01', '2026-11-15');
    expect(r.success).toBe(false);
    expect(r.reason).toBe('meta_read_failed');
  });

  it.each([
    ['2026-11-15', '2026-11-01'],
    ['2026-13-01', '2026-11-15'],
    ['yesterday', '2026-11-15'],
  ])('rejects an invalid window since=%s until=%s before any read', async (since, until) => {
    admin();
    const r = await readClientMetaBudgets('admin', 'owner@haven.com', since, until);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('invalid_window');
    expect(metaFetch).not.toHaveBeenCalled();
  });
});
