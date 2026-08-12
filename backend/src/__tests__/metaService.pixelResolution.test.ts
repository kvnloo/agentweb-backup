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
