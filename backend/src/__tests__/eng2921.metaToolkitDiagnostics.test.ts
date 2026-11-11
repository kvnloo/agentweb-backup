jest.mock('../services/agentApiKeyService', () => ({ agentApiKeyService: {} }));
jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: {} }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../services/mcpUsageEventsService', () => ({ recordMcpToolUse: jest.fn(), recordMcpWriteExecuted: jest.fn() }));
jest.mock('../services/agentModeService', () => ({ agentModeService: { readToolkitMetaActivityLog: jest.fn().mockResolvedValue({ data: [] }) } }));
import { ACTIVITY_FIELDS, executeActivityLogRead, explainMetaError, metaReadFailureResult } from '../mcp/metaToolkitDiagnostics';
import { getMetaToolkitManifest } from '../mcp/metaToolkitManifest';
import { handleMetaToolkitCall } from '../mcp/metaToolkitGateway';
import { agentModeService } from '../services/agentModeService';

const credentials = { accountId: '123', accessToken: 'secret' };
const deps = (scopes: string[], extra: any = {}) => ({
  validateApiKey: jest.fn().mockResolvedValue({ userId: 'u1', keyId: 'k1', scopes }),
  listAccounts: jest.fn().mockResolvedValue([{ platform: 'meta', account_id: '123', config: { account_type: 'ad_account', ad_account_id: '123', access_token: 'x' } }]),
  now: () => 0,
  rateLimiter: { check: () => ({ allowed: true }) },
  ...extra,
}) as any;

describe('ENG-2921 account diagnostics', () => {
  beforeEach(() => jest.clearAllMocks());

  it('advertises both tools', () => {
    const names = getMetaToolkitManifest().map((d: any) => d.name);
    expect(names).toEqual(expect.arrayContaining(['ads_account_get_activity_logs', 'ads_get_errors']));
  });

  it('activity log works with only read scope, account-bound, no write metering', async () => {
    const recordWrite = jest.fn();
    const recordUsage = jest.fn();
    await handleMetaToolkitCall({ authorization: 'Bearer aw_fixture', toolName: 'ads_account_get_activity_logs' }, deps(['tools:read'], { recordUsage, recordWrite }));
    expect(agentModeService.readToolkitMetaActivityLog).toHaveBeenCalledWith('u1', { account_id: '123' });
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordWrite).not.toHaveBeenCalled();
  });

  it('denies keys without read scope before account resolution', async () => {
    const d = deps(['email:read']);
    await expect(handleMetaToolkitCall({ authorization: 'Bearer aw_fixture', toolName: 'ads_account_get_activity_logs' }, d)).rejects.toMatchObject({ status: 403 });
    expect(d.listAccounts).not.toHaveBeenCalled();
  });

  it('error explainer needs no ad account and makes no Meta call', async () => {
    const d = deps(['tools:read'], { listAccounts: jest.fn().mockResolvedValue([]), recordUsage: jest.fn() });
    const out = await handleMetaToolkitCall({ authorization: 'Bearer aw_fixture', toolName: 'ads_get_errors', args: { code: '190' } }, d);
    expect(out).toMatchObject({ code: '190', known: true });
    expect(d.listAccounts).not.toHaveBeenCalled();
    expect(agentModeService.readToolkitMetaActivityLog).not.toHaveBeenCalled();
  });

  it('explains unknown codes without inventing a meaning', () => {
    expect(explainMetaError({ code: '999999' })).toMatchObject({ known: false });
  });

  it.each([[{}], [{ code: 'abc' }], [{ code: '190', access_token: 'x' }]])('explainer rejects %o', (args) => {
    expect(() => explainMetaError(args)).toThrow();
  });

  it('reads the selected account activities edge with fields, window and paging', async () => {
    const get = jest.fn().mockResolvedValue({ data: { data: [] } });
    await executeActivityLogRead({ since: '2026-11-01', until: '1762800000', limit: 10, after: 'c1' }, credentials, { get } as any);
    expect(get).toHaveBeenCalledWith(expect.stringMatching(/\/act_123\/activities$/), expect.objectContaining({
      params: { fields: ACTIVITY_FIELDS, limit: 10, since: '2026-11-01', until: '1762800000', after: 'c1', access_token: 'secret' },
    }));
  });

  it.each([
    [{ limit: 0 }],
    [{ since: 'yesterday' }],
    [{ access_token: 'evil' }],
    [{ after: 5 }],
  ])('activity log rejects %o before Graph calls', async (args) => {
    const get = jest.fn();
    await expect(executeActivityLogRead(args, credentials, { get } as any)).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });

  it('strips token-bearing paging URLs but keeps cursors', async () => {
    const get = jest.fn().mockResolvedValue({ data: { data: [], paging: {
      cursors: { after: 'c2' }, next: 'https://graph.facebook.com/x?access_token=secret&after=c2',
    } } });
    const result: any = await executeActivityLogRead({}, credentials, { get } as any);
    expect(result.paging).toEqual({ cursors: { after: 'c2' }, has_next: true, has_previous: false });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it.each(['../me', '123/../456', ''])('refuses a malformed account id %p before Graph calls', async (accountId) => {
    const get = jest.fn();
    await expect(executeActivityLogRead({}, { ...credentials, accountId }, { get } as any)).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });

  it('treats blank optional strings as absent', async () => {
    const get = jest.fn().mockResolvedValue({ data: { data: [] } });
    await executeActivityLogRead({ after: ' ' }, credentials, { get } as any);
    expect(get.mock.calls[0][1].params).not.toHaveProperty('after');
  });

  it('turns a Meta 190 refusal into a readable reconnect result, not a throw', async () => {
    const err: any = Object.assign(new Error('Request failed with status code 400'), {
      response: { status: 400, data: { error: { code: 190, message: 'Error validating access token' } } },
    });
    const get = jest.fn().mockRejectedValue(err);
    const result: any = await executeActivityLogRead({}, credentials, { get } as any);
    expect(result.success).toBe(false);
    expect(result.message).toContain('Ask the user to reconnect Meta in Connected Accounts');
    expect(result.errorClass).toBe('auth');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('maps a credential-resolution auth failure to the reconnect result', () => {
    const authErr = Object.assign(new Error('Meta access token expired'), { isMetaAuthError: true, status: 401 });
    const result: any = metaReadFailureResult(authErr);
    expect(result.success).toBe(false);
    expect(result.message).toContain('reconnect Meta');
  });
});
