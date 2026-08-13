/**
 * `updateAccountConfig` merge + unset semantics.
 *
 * The `unset` option exists because a plain merge can only add or overwrite
 * (ENG-1158). Fields that record a past observation — `ads_scope_revoked_at` —
 * had no way to be retracted once the observation stopped being true, which is
 * what left an owner who re-granted their Meta Ads permission out of band
 * permanently refused.
 */

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
}));

import { updateAccountConfig } from '../services/connectedAccountsDb';
import { userDb } from '../services/db';

const metaAccount = () => ({
  platform: 'meta',
  account_id: '922903076601160',
  account_name: 'AgentWeb',
  config: {
    account_type: 'ad_account',
    ad_account_id: '922903076601160',
    access_token: 'EAA-token',
    token_expires_at: 1791518072617,
    granted_scopes: [],
    ads_scope_revoked_at: '2026-07-31T07:00:21.688Z',
    ads_scope_alerted_at: '2026-08-13T07:00:00.000Z',
  },
  created_at: '2026-02-20T06:18:26.758Z',
  updated_at: '2026-08-10T03:54:32.885Z',
});

/** The config the call actually persisted. */
const persistedConfig = () =>
  (userDb.updateUser as jest.Mock).mock.calls[0][1].connected_accounts[0].config;

describe('updateAccountConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      userId: 'user-1',
      email: 'founders@agentweb.pro',
      connected_accounts: [metaAccount()],
    });
    (userDb.updateUser as jest.Mock).mockResolvedValue(undefined);
  });

  it('merges updates over the existing config, leaving untouched fields alone', async () => {
    await updateAccountConfig('user-1', 'meta', '922903076601160', {
      granted_scopes: ['ads_read'],
    });

    const config = persistedConfig();
    expect(config.granted_scopes).toEqual(['ads_read']);
    expect(config.access_token).toBe('EAA-token');
    expect(config.account_type).toBe('ad_account');
  });

  it('removes the keys named in `unset`', async () => {
    await updateAccountConfig(
      'user-1',
      'meta',
      '922903076601160',
      { granted_scopes: ['ads_read'] },
      { unset: ['ads_scope_revoked_at', 'ads_scope_alerted_at'] }
    );

    const config = persistedConfig();
    expect('ads_scope_revoked_at' in config).toBe(false);
    expect('ads_scope_alerted_at' in config).toBe(false);
    expect(config.granted_scopes).toEqual(['ads_read']);
  });

  it('removes the key outright rather than storing undefined', async () => {
    // The distinction is the point: an `ads_scope_revoked_at: undefined` left in
    // the object makes removal depend on marshalling behaviour instead of on
    // anything the caller asked for.
    await updateAccountConfig('user-1', 'meta', '922903076601160', {}, {
      unset: ['ads_scope_revoked_at'],
    });

    expect(Object.keys(persistedConfig())).not.toContain('ads_scope_revoked_at');
  });

  it('is a no-op on `unset` keys that were never there', async () => {
    await updateAccountConfig('user-1', 'meta', '922903076601160', {}, {
      unset: ['never_present'],
    });

    expect(persistedConfig().ads_scope_revoked_at).toBe('2026-07-31T07:00:21.688Z');
  });

  it('behaves exactly as before when no options are passed', async () => {
    await updateAccountConfig('user-1', 'meta', '922903076601160', { granted_scopes: [] });

    const config = persistedConfig();
    expect(config.ads_scope_revoked_at).toBe('2026-07-31T07:00:21.688Z');
    expect(config.ads_scope_alerted_at).toBe('2026-08-13T07:00:00.000Z');
  });

  it('throws when the account is not connected', async () => {
    await expect(
      updateAccountConfig('user-1', 'meta', 'not-connected', { granted_scopes: [] })
    ).rejects.toThrow(/No meta account/);
  });
});
