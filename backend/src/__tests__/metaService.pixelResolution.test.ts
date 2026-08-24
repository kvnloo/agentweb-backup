/**
 * resolveMetaPixelForUser.
 *
 * Auto-resolves which Meta pixel a lander should use from the site owner's already-connected
 * Meta ad account, so generation doesn't require a manually-typed field (unlike GTM). Uses
 * `pixel.id` directly as the dataset id (Meta unified pixel+dataset in Graph v25) — this
 * deliberately never calls the per-pixel `listDatasets` edge, which is broken (ENG-399).
 *
 * Must never throw: a Meta API hiccup, an unconnected account, or an ambiguous pixel set must
 * all resolve to `{ unresolved: true, reason }` so generation can proceed without tracking
 * (AC3 — fail loud, never fail generation).
 */

import { metaService } from '../services/metaService';

jest.mock('../services/metaPixelsCache', () => ({
  getCachedPixels: jest.fn(() => null),
}));

jest.mock('../services/metaAccountCredentials', () => ({
  getConnectedMetaAccountsList: jest.fn(),
  getMetaAccountCredentials: jest.fn(),
}));

import { getConnectedMetaAccountsList, getMetaAccountCredentials } from '../services/metaAccountCredentials';

describe('resolveMetaPixelForUser', () => {
  let mockFetch: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    mockFetch.mockRestore();
  });

  const user = { connected_accounts: [{ platform: 'facebook', config: { account_type: 'ad_account', access_token: 'tok' } }] };

  it('is unresolved when zero Meta ad accounts are connected', async () => {
    (getConnectedMetaAccountsList as jest.Mock).mockReturnValue([]);

    const result = await metaService.resolveMetaPixelForUser(user, 'user1');
    expect('unresolved' in result && result.unresolved).toBe(true);
    expect(getMetaAccountCredentials).not.toHaveBeenCalled();
  });

  it('is unresolved when 2+ Meta ad accounts are connected (no default-account concept yet)', async () => {
    (getConnectedMetaAccountsList as jest.Mock).mockReturnValue([
      { accountId: 'acc1' },
      { accountId: 'acc2' },
    ]);

    const result = await metaService.resolveMetaPixelForUser(user, 'user1');
    expect('unresolved' in result && result.unresolved).toBe(true);
  });

  it('is unresolved when the one connected account has zero pixels', async () => {
    (getConnectedMetaAccountsList as jest.Mock).mockReturnValue([{ accountId: 'acc1' }]);
    (getMetaAccountCredentials as jest.Mock).mockResolvedValue({ accountId: 'acc1', accessToken: 'tok', accountName: 'Acc 1' });
    mockFetch.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({ data: [] }) });

    const result = await metaService.resolveMetaPixelForUser(user, 'user1');
    expect('unresolved' in result && result.unresolved).toBe(true);
  });

  it('is unresolved when the one connected account has 2+ pixels (ambiguous)', async () => {
    (getConnectedMetaAccountsList as jest.Mock).mockReturnValue([{ accountId: 'acc1' }]);
    (getMetaAccountCredentials as jest.Mock).mockResolvedValue({ accountId: 'acc1', accessToken: 'tok', accountName: 'Acc 1' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ data: [{ id: 'px1' }, { id: 'px2' }] }),
    });

    const result = await metaService.resolveMetaPixelForUser(user, 'user1');
    expect('unresolved' in result && result.unresolved).toBe(true);
  });

  it('is unresolved (not rethrown) when the Graph call throws', async () => {
    (getConnectedMetaAccountsList as jest.Mock).mockReturnValue([{ accountId: 'acc1' }]);
    (getMetaAccountCredentials as jest.Mock).mockRejectedValue(new Error('token expired'));

    const result = await metaService.resolveMetaPixelForUser(user, 'user1');
    expect('unresolved' in result && result.unresolved).toBe(true);
    expect((result as any).reason).toContain('token expired');
  });

  it('resolves pixelId + accountId when exactly one account has exactly one pixel', async () => {
    (getConnectedMetaAccountsList as jest.Mock).mockReturnValue([{ accountId: 'acc1' }]);
    (getMetaAccountCredentials as jest.Mock).mockResolvedValue({ accountId: 'acc1', accessToken: 'tok', accountName: 'Acc 1' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ data: [{ id: '1430870751246428', name: 'AgentWeb' }] }),
    });

    const result = await metaService.resolveMetaPixelForUser(user, 'user1');
    expect(result).toEqual({ pixelId: '1430870751246428', accountId: 'acc1' });
  });

  it('never calls the broken per-pixel listDatasets edge (pins the ENG-399 workaround)', async () => {
    (getConnectedMetaAccountsList as jest.Mock).mockReturnValue([{ accountId: 'acc1' }]);
    (getMetaAccountCredentials as jest.Mock).mockResolvedValue({ accountId: 'acc1', accessToken: 'tok', accountName: 'Acc 1' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ data: [{ id: 'px1' }] }),
    });

    await metaService.resolveMetaPixelForUser(user, 'user1');
    const datasetCalls = mockFetch.mock.calls.filter((c: any[]) => String(c[0]).includes('/datasets'));
    expect(datasetCalls).toHaveLength(0);
  });

});

/**
 * resolveMetaPixelWithDefault (ENG-1141 rework) — Calendly's resolution, distinct from
 * resolveMetaPixelForUser: a booking webhook is unattended, so ambiguity must default to
 * the first connected account's first pixel instead of refusing. An explicit stored choice
 * (the Calendly card's account/pixel dropdowns) always wins when present.
 */
describe('resolveMetaPixelWithDefault', () => {
  let mockFetch: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    mockFetch.mockRestore();
  });

  const user = { connected_accounts: [{ platform: 'facebook', config: { account_type: 'ad_account', access_token: 'tok' } }] };

  it('uses the stored value directly when present, with zero network calls', async () => {
    // The stored account must be declared connected AND the pixel must still exist — an
    // explicit choice is only honored while what it names is still real (see the
    // stale-selection and stored-pixel-existence tests below). Both checks are local here:
    // the connected list comes from the loaded user record, the pixel from the warm cache.
    (getConnectedMetaAccountsList as jest.Mock).mockReturnValue([{ accountId: 'storedAcc' }]);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (require('../services/metaPixelsCache').getCachedPixels as jest.Mock)
      .mockReturnValue([{ pixelId: 'storedPixel', accountId: 'storedAcc' }]);

    const result = await metaService.resolveMetaPixelWithDefault(user, 'user1', { pixelId: 'storedPixel', accountId: 'storedAcc' });

    expect(result).toEqual({ pixelId: 'storedPixel', accountId: 'storedAcc' });
    // getConnectedMetaAccountsList IS now called (a local, already-loaded-record check).
    // What must stay zero is Graph traffic: no credential fetch, no HTTP.
    expect(getMetaAccountCredentials).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('defaults to the first connected account and its first pixel when nothing is stored', async () => {
    (getConnectedMetaAccountsList as jest.Mock).mockReturnValue([
      { accountId: 'acc1' },
      { accountId: 'acc2' },
    ]);
    (getMetaAccountCredentials as jest.Mock).mockResolvedValue({ accountId: 'acc1', accessToken: 'tok', accountName: 'Acc 1' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ data: [{ id: 'firstPixel' }, { id: 'secondPixel' }] }),
    });

    const result = await metaService.resolveMetaPixelWithDefault(user, 'user1', undefined);

    expect(result).toEqual({ pixelId: 'firstPixel', accountId: 'acc1' });
    // Confirms it queried the FIRST account specifically, not just any account.
    expect(getMetaAccountCredentials).toHaveBeenCalledWith(user, 'user1', 'acc1');
  });

  it('is unresolved when no Meta ad account is connected', async () => {
    (getConnectedMetaAccountsList as jest.Mock).mockReturnValue([]);

    const result = await metaService.resolveMetaPixelWithDefault(user, 'user1', undefined);

    expect('unresolved' in result && result.unresolved).toBe(true);
    expect(getMetaAccountCredentials).not.toHaveBeenCalled();
  });

  it('REGRESSION (live-test caught this): falls through to a second account when the first has zero pixels, instead of stopping at the first account', async () => {
    // The whole point of this resolver is "always resolvable once ANY connected
    // account has a pixel" — a customer whose first-listed account happens to have
    // none must not be told unresolved when a later account would have worked.
    (getConnectedMetaAccountsList as jest.Mock).mockReturnValue([{ accountId: 'acc1' }, { accountId: 'acc2' }]);
    (getMetaAccountCredentials as jest.Mock)
      .mockResolvedValueOnce({ accountId: 'acc1', accessToken: 'tok1', accountName: 'Acc 1' })
      .mockResolvedValueOnce({ accountId: 'acc2', accessToken: 'tok2', accountName: 'Acc 2' });
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ data: [] }) })
      .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ data: [{ id: 'secondAccountPixel' }] }) });

    const result = await metaService.resolveMetaPixelWithDefault(user, 'user1', undefined);

    expect(result).toEqual({ pixelId: 'secondAccountPixel', accountId: 'acc2' });
    expect(getMetaAccountCredentials).toHaveBeenCalledTimes(2);
    expect(getMetaAccountCredentials).toHaveBeenNthCalledWith(1, user, 'user1', 'acc1');
    expect(getMetaAccountCredentials).toHaveBeenNthCalledWith(2, user, 'user1', 'acc2');
  });

  it('is unresolved when every connected account has zero pixels', async () => {
    (getConnectedMetaAccountsList as jest.Mock).mockReturnValue([{ accountId: 'acc1' }, { accountId: 'acc2' }]);
    (getMetaAccountCredentials as jest.Mock)
      .mockResolvedValueOnce({ accountId: 'acc1', accessToken: 'tok1', accountName: 'Acc 1' })
      .mockResolvedValueOnce({ accountId: 'acc2', accessToken: 'tok2', accountName: 'Acc 2' });
    mockFetch.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({ data: [] }) });

    const result = await metaService.resolveMetaPixelWithDefault(user, 'user1', undefined);

    expect('unresolved' in result && result.unresolved).toBe(true);
    expect(getMetaAccountCredentials).toHaveBeenCalledTimes(2);
  });

  it('skips an account whose credential lookup fails and tries the next one', async () => {
    (getConnectedMetaAccountsList as jest.Mock).mockReturnValue([{ accountId: 'acc1' }, { accountId: 'acc2' }]);
    (getMetaAccountCredentials as jest.Mock)
      .mockRejectedValueOnce(new Error('token expired'))
      .mockResolvedValueOnce({ accountId: 'acc2', accessToken: 'tok2', accountName: 'Acc 2' });
    mockFetch.mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ data: [{ id: 'workingPixel' }] }) });

    const result = await metaService.resolveMetaPixelWithDefault(user, 'user1', undefined);

    expect(result).toEqual({ pixelId: 'workingPixel', accountId: 'acc2' });
  });

  it('is unresolved (not rethrown) when the Graph call throws', async () => {
    (getConnectedMetaAccountsList as jest.Mock).mockReturnValue([{ accountId: 'acc1' }]);
    (getMetaAccountCredentials as jest.Mock).mockRejectedValue(new Error('token expired'));

    const result = await metaService.resolveMetaPixelWithDefault(user, 'user1', undefined);

    expect('unresolved' in result && result.unresolved).toBe(true);
    expect((result as any).reason).toContain('token expired');
  });

  // Greptile P1 on #2384: the stored pair is a snapshot of a choice made earlier, so it
  // can outlive the connection it names (customer disconnects that Meta account, or a
  // reconnect issues a new account id). Honoring it blindly then sends every subsequent
  // booking down a path whose credentials no longer resolve — the CAPI leg throws, the
  // job is marked failed and retried to exhaustion, and a perfectly healthy pixel on
  // another connected account is never tried. Pass 1 of this feature had this check and
  // the Pass-2 rework dropped it; these pin it so it can't be dropped again.
  it('falls through to the default search when the stored account is no longer connected', async () => {
    (getConnectedMetaAccountsList as jest.Mock).mockReturnValue([{ accountId: 'stillConnected' }]);
    (getMetaAccountCredentials as jest.Mock).mockResolvedValue({ accountId: 'stillConnected', accessToken: 'tok', accountName: 'Live' });
    mockFetch.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({ data: [{ id: 'healthyPixel' }] }) });

    const result = await metaService.resolveMetaPixelWithDefault(user, 'user1', {
      pixelId: 'stalePixel',
      accountId: 'disconnectedAccount',
    });

    expect(result).toEqual({ pixelId: 'healthyPixel', accountId: 'stillConnected' });
  });

  it('is unresolved (not stale-selected) when the stored account is gone and no other account has a pixel', async () => {
    (getConnectedMetaAccountsList as jest.Mock).mockReturnValue([{ accountId: 'otherAcc' }]);
    (getMetaAccountCredentials as jest.Mock).mockResolvedValue({ accountId: 'otherAcc', accessToken: 'tok', accountName: 'Other' });
    mockFetch.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({ data: [] }) });

    const result = await metaService.resolveMetaPixelWithDefault(user, 'user1', {
      pixelId: 'stalePixel',
      accountId: 'disconnectedAccount',
    });

    expect('unresolved' in result && result.unresolved).toBe(true);
    expect(result).not.toEqual({ pixelId: 'stalePixel', accountId: 'disconnectedAccount' });
  });

  it('still honors the stored pair when its account is connected, without any Graph traffic', async () => {
    (getConnectedMetaAccountsList as jest.Mock).mockReturnValue([{ accountId: 'acc1' }, { accountId: 'storedAcc' }]);
    // Warm cache: the pixel-existence check below is answered locally, so this stays zero-traffic.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (require('../services/metaPixelsCache').getCachedPixels as jest.Mock)
      .mockReturnValue([{ pixelId: 'storedPixel', accountId: 'storedAcc' }]);

    const result = await metaService.resolveMetaPixelWithDefault(user, 'user1', { pixelId: 'storedPixel', accountId: 'storedAcc' });

    expect(result).toEqual({ pixelId: 'storedPixel', accountId: 'storedAcc' });
    // The connectivity check is local (reads the already-loaded user record). What must
    // NOT happen is a per-booking Graph round-trip just to confirm a stored choice.
    expect(getMetaAccountCredentials).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('honors the stored pair when the connected-accounts list cannot be read, rather than discarding the choice', async () => {
    // Defensive: a malformed/unreadable user record must not silently downgrade an
    // explicit customer choice into "pick whatever comes first".
    (getConnectedMetaAccountsList as jest.Mock).mockImplementation(() => { throw new Error('bad user record'); });

    const result = await metaService.resolveMetaPixelWithDefault(user, 'user1', { pixelId: 'storedPixel', accountId: 'storedAcc' });

    expect(result).toEqual({ pixelId: 'storedPixel', accountId: 'storedAcc' });
  });

  // Greptile (round 4) on #2384: checking only that the ACCOUNT is still connected leaves the
  // other half of staleness — the pixel itself can be deleted from an account that is still
  // connected. Verified through the shared /pixels cache so the common case costs nothing.
  describe('stored pixel existence', () => {
    const { getCachedPixels } = require('../services/metaPixelsCache');

    it('honors the stored pixel when the warm cache lists it, with zero Graph traffic', async () => {
      (getConnectedMetaAccountsList as jest.Mock).mockReturnValue([{ accountId: 'storedAcc' }]);
      (getCachedPixels as jest.Mock).mockReturnValue([{ pixelId: 'storedPixel', accountId: 'storedAcc' }]);

      const result = await metaService.resolveMetaPixelWithDefault(user, 'user1', { pixelId: 'storedPixel', accountId: 'storedAcc' });

      expect(result).toEqual({ pixelId: 'storedPixel', accountId: 'storedAcc' });
      expect(getMetaAccountCredentials).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('falls through when the warm cache shows the stored pixel is gone', async () => {
      (getConnectedMetaAccountsList as jest.Mock).mockReturnValue([{ accountId: 'storedAcc' }]);
      (getCachedPixels as jest.Mock).mockReturnValue([{ pixelId: 'someOtherPixel', accountId: 'storedAcc' }]);
      (getMetaAccountCredentials as jest.Mock).mockResolvedValue({ accountId: 'storedAcc', accessToken: 'tok', accountName: 'Acc' });
      mockFetch.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({ data: [{ id: 'someOtherPixel' }] }) });

      const result = await metaService.resolveMetaPixelWithDefault(user, 'user1', { pixelId: 'deletedPixel', accountId: 'storedAcc' });

      expect(result).toEqual({ pixelId: 'someOtherPixel', accountId: 'storedAcc' });
    });

    it('verifies against Graph exactly once when the cache is cold, and honors a pixel that exists', async () => {
      (getConnectedMetaAccountsList as jest.Mock).mockReturnValue([{ accountId: 'storedAcc' }]);
      (getCachedPixels as jest.Mock).mockReturnValue(null);
      (getMetaAccountCredentials as jest.Mock).mockResolvedValue({ accountId: 'storedAcc', accessToken: 'tok', accountName: 'Acc' });
      mockFetch.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({ data: [{ id: 'storedPixel' }] }) });

      const result = await metaService.resolveMetaPixelWithDefault(user, 'user1', { pixelId: 'storedPixel', accountId: 'storedAcc' });

      expect(result).toEqual({ pixelId: 'storedPixel', accountId: 'storedAcc' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('falls through to another account when a cold check shows the stored pixel is gone', async () => {
      (getConnectedMetaAccountsList as jest.Mock).mockReturnValue([{ accountId: 'storedAcc' }, { accountId: 'healthyAcc' }]);
      (getCachedPixels as jest.Mock).mockReturnValue(null);
      (getMetaAccountCredentials as jest.Mock)
        .mockResolvedValueOnce({ accountId: 'storedAcc', accessToken: 'tok', accountName: 'Stored' })
        .mockResolvedValueOnce({ accountId: 'storedAcc', accessToken: 'tok', accountName: 'Stored' })
        .mockResolvedValueOnce({ accountId: 'healthyAcc', accessToken: 'tok2', accountName: 'Healthy' });
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ data: [] }) })            // verification: gone
        .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ data: [] }) })            // storedAcc has none
        .mockResolvedValueOnce({ ok: true, json: jest.fn().mockResolvedValue({ data: [{ id: 'live' }] }) });

      const result = await metaService.resolveMetaPixelWithDefault(user, 'user1', { pixelId: 'deletedPixel', accountId: 'storedAcc' });

      expect(result).toEqual({ pixelId: 'live', accountId: 'healthyAcc' });
    });

    // Greptile round 5 on #2384: these two failures look alike and must not behave alike.
    it('keeps the stored choice when META is unreachable — an outage must not silently repoint attribution', async () => {
      (getConnectedMetaAccountsList as jest.Mock).mockReturnValue([{ accountId: 'storedAcc' }]);
      (getCachedPixels as jest.Mock).mockReturnValue(null);
      (getMetaAccountCredentials as jest.Mock).mockResolvedValue({ accountId: 'storedAcc', accessToken: 'tok', accountName: 'Acc' });
      mockFetch.mockRejectedValue(new Error('graph unreachable'));

      const result = await metaService.resolveMetaPixelWithDefault(user, 'user1', { pixelId: 'storedPixel', accountId: 'storedAcc' });

      expect(result).toEqual({ pixelId: 'storedPixel', accountId: 'storedAcc' });
    });

    it('abandons the stored choice when its own credentials are unusable, so a healthy account still wins', async () => {
      // Credentials failing is evidence about the PAIR, not about Meta: keeping it would send
      // every later booking down a path that cannot resolve, retried to exhaustion, while a
      // healthy pixel sits unused — the very failure the connectivity check exists to prevent.
      (getConnectedMetaAccountsList as jest.Mock).mockReturnValue([{ accountId: 'storedAcc' }, { accountId: 'healthyAcc' }]);
      (getCachedPixels as jest.Mock).mockReturnValue(null);
      (getMetaAccountCredentials as jest.Mock)
        .mockRejectedValueOnce(new Error('token revoked'))                                              // verification
        .mockRejectedValueOnce(new Error('token revoked'))                                              // storedAcc during search
        .mockResolvedValueOnce({ accountId: 'healthyAcc', accessToken: 'tok2', accountName: 'Healthy' });
      mockFetch.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({ data: [{ id: 'livePixel' }] }) });

      const result = await metaService.resolveMetaPixelWithDefault(user, 'user1', { pixelId: 'storedPixel', accountId: 'storedAcc' });

      expect(result).toEqual({ pixelId: 'livePixel', accountId: 'healthyAcc' });
    });
  });

  it('ignores a partially-stored value (pixelId without accountId) and falls through to the default', async () => {
    (getConnectedMetaAccountsList as jest.Mock).mockReturnValue([{ accountId: 'acc1' }]);
    (getMetaAccountCredentials as jest.Mock).mockResolvedValue({ accountId: 'acc1', accessToken: 'tok', accountName: 'Acc 1' });
    mockFetch.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({ data: [{ id: 'fallbackPixel' }] }) });

    const result = await metaService.resolveMetaPixelWithDefault(user, 'user1', { pixelId: 'orphanPixel' } as any);

    expect(result).toEqual({ pixelId: 'fallbackPixel', accountId: 'acc1' });
  });
});
