import { encryptPassword } from '../../utils/crypto';
import { SmartleadApiError } from '../smartleadService';

const mockGetAccounts = jest.fn();
const mockUpdateAccountConfig = jest.fn();
jest.mock('../connectedAccountsDb', () => ({
  getAccountsWithOwnerIncludingOrgShared: (...a: any[]) => mockGetAccounts(...a),
  updateAccountConfig: (...a: any[]) => mockUpdateAccountConfig(...a),
}));

const mockListEmailAccounts = jest.fn();
jest.mock('../smartleadService', () => ({
  ...jest.requireActual('../smartleadService'),
  listEmailAccounts: (...a: any[]) => mockListEmailAccounts(...a),
}));

import { resolveSmartlead, reportSmartleadFailure } from '../smartleadConnection';

const row = (owner: string, over: Record<string, any> = {}, key = `key-of-${owner}`) => ({
  platform: 'smartlead',
  account_id: `smartlead-${owner}`,
  account_name: 'Smartlead',
  userId: owner,
  config: { account_type: 'api_key', access_token: encryptPassword(key, owner), ...over },
});

describe('resolveSmartlead (ENG-673)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('says not connected when there is no Smartlead account', async () => {
    mockGetAccounts.mockResolvedValue([{ platform: 'luma', account_id: 'x', userId: 'me', config: {} }]);
    await expect(resolveSmartlead('me')).resolves.toMatchObject({ ok: false, reason: 'not_connected' });
  });

  it('uses the callers own connection even when teammates have shared theirs', async () => {
    mockGetAccounts.mockResolvedValue([row('me'), row('mate')]);
    const r = await resolveSmartlead('me');
    expect(r).toMatchObject({ ok: true, apiKey: 'key-of-me', ownerUserId: 'me', accountId: 'smartlead-me' });
  });

  it('uses the single connection a teammate shared, and reports the teammate as the owner', async () => {
    mockGetAccounts.mockResolvedValue([row('mate')]);
    const r = await resolveSmartlead('me');
    expect(r).toMatchObject({ ok: true, apiKey: 'key-of-mate', ownerUserId: 'mate', accountId: 'smartlead-mate' });
  });

  it('does not guess between several shared connections when the caller has none', async () => {
    mockGetAccounts.mockResolvedValue([row('mate'), row('boss')]);
    const r = await resolveSmartlead('me');
    expect(r).toMatchObject({ ok: false, reason: 'choose' });
    expect((r as any).candidates).toEqual([
      { accountId: 'smartlead-mate', ownerUserId: 'mate', accountName: 'Smartlead' }, // the saved name, so a picker can show it
      { accountId: 'smartlead-boss', ownerUserId: 'boss', accountName: 'Smartlead' },
    ]);
  });

  it('tells a teammate using a shared key that only the owner can replace it', async () => {
    mockGetAccounts.mockResolvedValue([row('mate', { needs_reconnect: true })]);
    mockListEmailAccounts.mockRejectedValueOnce(new SmartleadApiError('no', 401));
    const r = await resolveSmartlead('me');
    expect(r).toMatchObject({ ok: false, reason: 'key_rejected' });
    expect((r as { message: string }).message).toMatch(/Ask the teammate/);
  });

  it('honours an explicit account id, and rejects one that is not available', async () => {
    mockGetAccounts.mockResolvedValue([row('mate'), row('boss')]);
    await expect(resolveSmartlead('me', 'smartlead-boss')).resolves.toMatchObject({ ok: true, apiKey: 'key-of-boss' });
    await expect(resolveSmartlead('me', 'smartlead-stranger')).resolves.toMatchObject({ ok: false, reason: 'not_connected' });
  });

  it('treats a key that cannot be decrypted as unusable, without throwing', async () => {
    mockGetAccounts.mockResolvedValue([row('me', { access_token: 'garbage' })]);
    await expect(resolveSmartlead('me')).resolves.toMatchObject({ ok: false, reason: 'key_unreadable' });
  });

  describe('a key flagged needs_reconnect', () => {
    beforeEach(() => mockGetAccounts.mockResolvedValue([row('me', { needs_reconnect: true })]));

    it('stays rejected while the probe is still refused (401 or 403), and writes nothing', async () => {
      for (const status of [401, 403]) {
        mockListEmailAccounts.mockRejectedValueOnce(new SmartleadApiError('no', status));
        await expect(resolveSmartlead('me')).resolves.toMatchObject({ ok: false, reason: 'key_rejected' });
      }
      expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
    });

    it('works again and clears the flag on the owners record once the probe succeeds', async () => {
      mockListEmailAccounts.mockResolvedValueOnce([]);
      await expect(resolveSmartlead('me')).resolves.toMatchObject({ ok: true });
      // The probe is one cheap call: no retries, first page only.
      expect(mockListEmailAccounts).toHaveBeenCalledWith('key-of-me', { maxRetries: 0, maxPages: 1 });
      expect(mockUpdateAccountConfig).toHaveBeenCalledTimes(1);
      const [owner, platform, accountId, mutation] = mockUpdateAccountConfig.mock.calls[0];
      expect([owner, platform, accountId]).toEqual(['me', 'smartlead', 'smartlead-me']);
      expect(mutation({})).toEqual({ updates: {}, unset: ['needs_reconnect'] });
    });

    it('lets the real call decide when the probe is inconclusive (timeout, 429, 5xx)', async () => {
      mockListEmailAccounts.mockRejectedValueOnce(new SmartleadApiError('slow', 500));
      await expect(resolveSmartlead('me')).resolves.toMatchObject({ ok: true });
      expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
    });
  });
});

describe('reportSmartleadFailure (ENG-673)', () => {
  const resolved = { ok: true as const, apiKey: 'k-1', ownerUserId: 'owner-9', accountId: 'smartlead-owner-9', accountName: 'Smartlead' };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('ignores errors that are not authorisation failures, without probing', async () => {
    await expect(reportSmartleadFailure(resolved, new SmartleadApiError('boom', 500))).resolves.toBe('not_an_auth_error');
    await expect(reportSmartleadFailure(resolved, new Error('network'))).resolves.toBe('not_an_auth_error');
    expect(mockListEmailAccounts).not.toHaveBeenCalled();
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });

  it.each([401, 403])('flags the OWNERs connection dead when a %i is confirmed by the probe', async (status) => {
    mockListEmailAccounts.mockRejectedValueOnce(new SmartleadApiError('rejected', status));
    await expect(reportSmartleadFailure(resolved, new SmartleadApiError('first', status))).resolves.toBe('key_rejected');
    expect(mockUpdateAccountConfig).toHaveBeenCalledWith('owner-9', 'smartlead', 'smartlead-owner-9', { needs_reconnect: true });
  });

  it('calls a 403 on a healthy key a forbidden resource, so a caller does not retry it as transient', async () => {
    mockListEmailAccounts.mockResolvedValueOnce([]);
    await expect(reportSmartleadFailure(resolved, new SmartleadApiError('forbidden', 403))).resolves.toBe('forbidden_resource');
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });

  it('does not flag the key when the probe still works', async () => {
    mockListEmailAccounts.mockResolvedValueOnce([]);
    await expect(reportSmartleadFailure(resolved, new SmartleadApiError('blip', 401))).resolves.toBe('transient_auth_error');
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });

  it('does not flag the key when the probe is inconclusive', async () => {
    mockListEmailAccounts.mockRejectedValueOnce(new SmartleadApiError('timeout', 504));
    await expect(reportSmartleadFailure(resolved, new SmartleadApiError('blip', 401))).resolves.toBe('transient_auth_error');
    expect(mockUpdateAccountConfig).not.toHaveBeenCalled();
  });
});
