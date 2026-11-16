/**
 * ENG-3070: admin read of one named client's Meta change history.
 * Mocked userDb, connected accounts, token sources and Graph; no live Meta call.
 */
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(), getUserByEmail: jest.fn(), getAllUsers: jest.fn() },
}));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserId: jest.fn() }));
jest.mock('../services/spendProjectionDb', () => ({ getProjectionsBatch: jest.fn() }));
jest.mock('../utils/secretsManager', () => ({ getMetaAccessToken: jest.fn().mockResolvedValue('shared-token') }));
jest.mock('../services/metaTokenRefresh', () => ({
  ensureFreshMetaAdAccountToken: jest.fn().mockResolvedValue({ attempted: false, refreshed: false }),
}));
jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));

import axios from 'axios';
import { readClientMetaActivity, findClientMatches } from '../services/clientHealthService';

const { userDb } = require('../services/db');
const { getAccountsByUserId } = require('../services/connectedAccountsDb');
const { getMetaAccessToken } = require('../utils/secretsManager');
const graphGet = (axios as any).get as jest.Mock;

const haven = { userId: 'u-haven', email: 'owner@haven.example', displayName: 'Haven Dental' };
const metaAccount = (config: Record<string, unknown>) => ({
  platform: 'meta', config: { account_type: 'ad_account', ...config },
});
const budgetEvent = {
  event_time: '2026-11-10T14:02:11+0000',
  event_type: 'update_ad_set_budget',
  object_id: '120200000000000001',
  object_name: 'Prospecting - Broad',
  object_type: 'ADSET',
  actor_name: 'Jordan Admin',
  extra_data: JSON.stringify({ old_value: { old_value: 5000, currency: 'USD' }, new_value: { new_value: 12000, currency: 'USD' } }),
};

beforeEach(() => {
  jest.clearAllMocks();
  userDb.getUserByEmail.mockResolvedValue(haven);
  userDb.getAllUsers.mockResolvedValue([]);
  getAccountsByUserId.mockResolvedValue([metaAccount({ ad_account_id: '111', access_token: 'client-token' })]);
});

describe('readClientMetaActivity (ENG-3070)', () => {
  it('reads the named client account with the client token and returns before/after for a budget change', async () => {
    graphGet.mockResolvedValue({
      data: {
        data: [budgetEvent, { event_time: '2026-11-09T09:00:00+0000', event_type: 'ad_account_update_spend_limit' }],
        paging: { cursors: { before: 'B', after: 'A' }, next: 'https://graph.facebook.com/x?access_token=client-token' },
      },
    });

    const result = await readClientMetaActivity('admin-1', 'owner@haven.example', { since: '2026-11-01', until: '2026-11-15' }, true);

    expect(result.success).toBe(true);
    expect(result.ad_account_id).toBe('111');
    expect(result.client).toEqual(haven);
    expect(result.credential_source).toBe('client_connection');
    expect(result.events[0]).toMatchObject({
      event_type: 'update_ad_set_budget', actor_name: 'Jordan Admin', object_name: 'Prospecting - Broad',
      before: { old_value: 5000, currency: 'USD' }, after: { new_value: 12000, currency: 'USD' },
    });
    // Meta sent no extra_data for the second event: nothing is invented.
    expect(result.events[1]).toEqual({ event_time: '2026-11-09T09:00:00+0000', event_type: 'ad_account_update_spend_limit' });
    expect(result.paging).toEqual({ cursors: { before: 'B', after: 'A' }, has_next: true, has_previous: false });
    expect(JSON.stringify(result)).not.toContain('client-token');

    const [url, options] = graphGet.mock.calls[0];
    expect(url).toMatch(/\/act_111\/activities$/);
    expect(options.params).toMatchObject({ since: '2026-11-01', until: '2026-11-15', access_token: 'client-token' });
    expect(getMetaAccessToken).not.toHaveBeenCalled();
  });

  it('refuses a non-admin caller before any lookup', async () => {
    userDb.getUserById.mockResolvedValue({ userId: 'cust-1', isAdmin: false });
    const result = await readClientMetaActivity('cust-1', 'owner@haven.example');
    expect(result).toMatchObject({ success: false, reason: 'not_admin', error: 'Admin access required' });
    expect(userDb.getUserByEmail).not.toHaveBeenCalled();
    expect(graphGet).not.toHaveBeenCalled();
  });

  it('refuses a name that matches more than one client and reads nothing', async () => {
    userDb.getUserByEmail.mockResolvedValue(undefined);
    userDb.getAllUsers.mockResolvedValue([haven, { userId: 'u-2', email: 'ops@havenspa.example', displayName: 'Haven Spa' }]);
    const result = await readClientMetaActivity('admin-1', 'haven', {}, true);
    expect(result).toMatchObject({ success: false, reason: 'ambiguous_client' });
    expect(result.matches).toHaveLength(2);
    expect(getAccountsByUserId).not.toHaveBeenCalled();
    expect(graphGet).not.toHaveBeenCalled();
  });

  it('reports an unknown client as not found', async () => {
    userDb.getUserByEmail.mockResolvedValue(undefined);
    const result = await readClientMetaActivity('admin-1', 'nobody', {}, true);
    expect(result).toMatchObject({ success: false, reason: 'client_not_found' });
  });

  it('refuses when the client has no Meta connection, never falling back to another account', async () => {
    getAccountsByUserId.mockResolvedValue([]);
    const result = await readClientMetaActivity('admin-1', 'owner@haven.example', {}, true);
    expect(result).toMatchObject({ success: false, reason: 'no_meta_connection' });
    expect(getAccountsByUserId).toHaveBeenCalledTimes(1);
    expect(getAccountsByUserId).toHaveBeenCalledWith('u-haven');
    expect(graphGet).not.toHaveBeenCalled();
  });

  it('refuses an expired connection that cannot refresh', async () => {
    getAccountsByUserId.mockResolvedValue([metaAccount({ ad_account_id: '111', access_token: 'old', token_expires_at: 1 })]);
    const result = await readClientMetaActivity('admin-1', 'owner@haven.example', {}, true);
    expect(result).toMatchObject({ success: false, reason: 'no_meta_connection', ad_account_id: '111' });
    expect(graphGet).not.toHaveBeenCalled();
  });

  it('refuses to read a connected account id with the shared token (pairing)', async () => {
    getAccountsByUserId.mockResolvedValue([metaAccount({ ad_account_id: '111' })]);
    const result = await readClientMetaActivity('admin-1', 'owner@haven.example', {}, true);
    expect(result).toMatchObject({ success: false, reason: 'credential_pair_mismatch' });
    expect(getMetaAccessToken).not.toHaveBeenCalled();
    expect(graphGet).not.toHaveBeenCalled();
  });

  it('reads a legacy adAccount with the shared token, id and token from the same source', async () => {
    userDb.getUserByEmail.mockResolvedValue({ ...haven, adAccount: '222' });
    getAccountsByUserId.mockResolvedValue([]);
    graphGet.mockResolvedValue({ data: { data: [] } });
    const result = await readClientMetaActivity('admin-1', 'owner@haven.example', {}, true);
    expect(result).toMatchObject({ success: true, ad_account_id: '222', credential_source: 'legacy_shared_token', events: [] });
    expect(graphGet.mock.calls[0][0]).toMatch(/\/act_222\/activities$/);
    expect(graphGet.mock.calls[0][1].params.access_token).toBe('shared-token');
  });

  it('reports a Meta token failure as a failure, not an empty history', async () => {
    graphGet.mockRejectedValue({
      response: { status: 400, data: { error: { message: 'Error validating access token', code: 190, type: 'OAuthException' } } },
    });
    const result = await readClientMetaActivity('admin-1', 'owner@haven.example', {}, true);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('meta_read_failed');
    expect(result.errorType).toBe('configuration');
    expect(result.ad_account_id).toBe('111');
    expect(result.events).toBeUndefined();
  });

  it('treats a response with no event array as unread', async () => {
    graphGet.mockResolvedValue({ data: {} });
    const result = await readClientMetaActivity('admin-1', 'owner@haven.example', {}, true);
    expect(result).toMatchObject({ success: false, reason: 'meta_read_failed' });
  });

  it('refuses a malformed window instead of reading without it', async () => {
    const result = await readClientMetaActivity('admin-1', 'owner@haven.example', { since: 'last tuesday' }, true);
    expect(result).toMatchObject({ success: false, reason: 'invalid_argument' });
    expect(graphGet).not.toHaveBeenCalled();
  });
});

describe('findClientMatches', () => {
  it('returns an exact email match alone, without scanning', async () => {
    expect(await findClientMatches('owner@haven.example')).toEqual([haven]);
    expect(userDb.getAllUsers).not.toHaveBeenCalled();
  });

  it('skips sandbox principals in both the email and the name path', async () => {
    const sandbox = { userId: 'eval_sandbox1', email: 'sandbox@haven.example', displayName: 'Haven Sandbox' };
    userDb.getUserByEmail.mockResolvedValue(sandbox);
    userDb.getAllUsers.mockResolvedValue([sandbox, haven]);
    expect(await findClientMatches('haven')).toEqual([haven]);
  });
});
