/**
 * ENG-629 — capture the scopes Meta ACTUALLY granted, not the ones we asked for.
 *
 * Root cause of OPS-79: `routes/metaAuth.ts` persisted `flowCfg.scopes` (the
 * requested set) onto every Meta connection, so `ads_read` + `ads_management`
 * were always recorded regardless of what the user consented to at the dialog.
 * Any capability gate reading that field would pass for exactly the account
 * that is failing in production.
 *
 * `debug_token` is the authoritative source: it reports both the flat `scopes`
 * list and `granular_scopes` (per-object grants). These tests mock the HTTP
 * boundary — no live OAuth (AC5).
 */

jest.mock('../utils/secretsManager', () => ({
  getMetaCredentials: jest.fn().mockResolvedValue({
    clientId: 'app-id',
    clientSecret: 'app-secret',
  }),
}));

import { metaService } from '../services/metaService';

const mockFetchOnce = (payload: any) => {
  (global as any).fetch = jest.fn().mockResolvedValue({
    json: async () => payload,
  });
};

describe('metaService.getGrantedScopes (ENG-629)', () => {
  const accessToken = 'EAA-user-token';

  afterEach(() => {
    jest.clearAllMocks();
    delete (global as any).fetch;
  });

  it('returns the flat scopes list Meta reports for the token', async () => {
    mockFetchOnce({ data: { scopes: ['ads_read', 'pages_show_list'] } });

    await expect(metaService.getGrantedScopes(accessToken)).resolves.toEqual(
      expect.arrayContaining(['ads_read', 'pages_show_list'])
    );
  });

  it('includes granular_scopes entries, which is where ads grants often appear', async () => {
    mockFetchOnce({
      data: {
        scopes: ['public_profile'],
        granular_scopes: [
          { scope: 'ads_management', target_ids: ['act_922903076601160'] },
          { scope: 'pages_show_list', target_ids: ['1234'] },
        ],
      },
    });

    const result = await metaService.getGrantedScopes(accessToken);

    expect(result).toEqual(expect.arrayContaining(['public_profile', 'ads_management', 'pages_show_list']));
  });

  it('de-duplicates a scope present in both scopes and granular_scopes', async () => {
    mockFetchOnce({
      data: {
        scopes: ['ads_read'],
        granular_scopes: [{ scope: 'ads_read', target_ids: ['act_1'] }],
      },
    });

    const result = await metaService.getGrantedScopes(accessToken);

    expect(result!.filter(s => s === 'ads_read')).toHaveLength(1);
  });

  it('reflects a consent where the user declined ads — the OPS-79 shape', async () => {
    mockFetchOnce({
      data: { scopes: ['public_profile', 'pages_show_list', 'pages_read_engagement'] },
    });

    const result = await metaService.getGrantedScopes(accessToken);

    expect(result).not.toContain('ads_read');
    expect(result).not.toContain('ads_management');
  });

  it('calls debug_token with the app token, never the user token as the inspector', async () => {
    mockFetchOnce({ data: { scopes: ['ads_read'] } });

    await metaService.getGrantedScopes(accessToken);

    const urls = ((global as any).fetch as jest.Mock).mock.calls.map((c: any[]) => c[0] as string);
    const debugUrl = urls.find(u => u.includes('debug_token'));
    expect(debugUrl).toBeDefined();
    expect(debugUrl).toContain(`input_token=${accessToken}`);
    expect(debugUrl).toContain('access_token=app-id%7Capp-secret');
  });

  /**
   * ENG-1158. `debug_token` authenticates with an APP token, so it can only
   * answer for tokens minted by the app whose credentials we currently hold.
   * Verified live against the dev test user: every Meta ad account there comes
   * back "(#100) The App_id in the input_token did not match the Viewing App",
   * leaving the grant permanently undeterminable — which silently disables both
   * connect-time recording and the capability reconciler. `/me/permissions`
   * needs only the user token and has no such precondition.
   */
  describe('/me/permissions is preferred over debug_token', () => {
    it('asks /me/permissions first, using the user token', async () => {
      mockFetchOnce({ data: [{ permission: 'ads_read', status: 'granted' }] });

      await metaService.getGrantedScopes(accessToken);

      const firstUrl = ((global as any).fetch as jest.Mock).mock.calls[0][0] as string;
      expect(firstUrl).toContain('/me/permissions');
      expect(firstUrl).toContain(`access_token=${accessToken}`);
    });

    it('returns the granted permissions without consulting debug_token at all', async () => {
      mockFetchOnce({
        data: [
          { permission: 'ads_read', status: 'granted' },
          { permission: 'pages_show_list', status: 'granted' },
        ],
      });

      const result = await metaService.getGrantedScopes(accessToken);

      expect(result).toEqual(expect.arrayContaining(['ads_read', 'pages_show_list']));
      const urls = ((global as any).fetch as jest.Mock).mock.calls.map((c: any[]) => c[0] as string);
      expect(urls.some(u => u.includes('debug_token'))).toBe(false);
    });

    it('excludes declined permissions — the whole point of asking', async () => {
      // A declined permission is listed too. Counting it would report capability
      // for a connection the user explicitly refused, which is OPS-79 again.
      mockFetchOnce({
        data: [
          { permission: 'public_profile', status: 'granted' },
          { permission: 'ads_read', status: 'declined' },
          { permission: 'ads_management', status: 'declined' },
        ],
      });

      const result = await metaService.getGrantedScopes(accessToken);

      expect(result).toEqual(['public_profile']);
      expect(result).not.toContain('ads_read');
    });

    it('falls back to debug_token when /me/permissions errors', async () => {
      (global as any).fetch = jest
        .fn()
        .mockResolvedValueOnce({ json: async () => ({ error: { message: 'nope', code: 190 } }) })
        .mockResolvedValueOnce({ json: async () => ({ data: { scopes: ['ads_read'] } }) });

      await expect(metaService.getGrantedScopes(accessToken)).resolves.toEqual(['ads_read']);
    });

    it('falls back to debug_token when /me/permissions returns an unusable shape', async () => {
      (global as any).fetch = jest
        .fn()
        .mockResolvedValueOnce({ json: async () => ({ data: {} }) })
        .mockResolvedValueOnce({ json: async () => ({ data: { scopes: ['ads_management'] } }) });

      await expect(metaService.getGrantedScopes(accessToken)).resolves.toEqual(['ads_management']);
    });

    it('returns undefined when neither route can answer', async () => {
      (global as any).fetch = jest
        .fn()
        .mockResolvedValue({ json: async () => ({ error: { message: 'app mismatch', code: 100 } }) });

      await expect(metaService.getGrantedScopes(accessToken)).resolves.toBeUndefined();
    });
  });

  it('returns undefined (not an empty array) when Meta returns an error payload', async () => {
    // Distinguishing "we could not ask" from "they granted nothing" matters: an
    // empty array would later be read as an authoritative refusal.
    mockFetchOnce({ error: { message: 'Invalid OAuth access token', code: 190 } });

    await expect(metaService.getGrantedScopes(accessToken)).resolves.toBeUndefined();
  });

  it('returns undefined when the request throws, never propagating the failure', async () => {
    (global as any).fetch = jest.fn().mockRejectedValue(new Error('network down'));

    await expect(metaService.getGrantedScopes(accessToken)).resolves.toBeUndefined();
  });

  it('returns undefined when the payload has no scope information at all', async () => {
    mockFetchOnce({ data: { app_id: '123', is_valid: true } });

    await expect(metaService.getGrantedScopes(accessToken)).resolves.toBeUndefined();
  });
});
