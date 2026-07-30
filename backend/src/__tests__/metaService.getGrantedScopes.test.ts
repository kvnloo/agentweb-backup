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

    const calledUrl = ((global as any).fetch as jest.Mock).mock.calls[0][0] as string;
    expect(calledUrl).toContain('debug_token');
    expect(calledUrl).toContain(`input_token=${accessToken}`);
    expect(calledUrl).toContain('access_token=app-id%7Capp-secret');
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
