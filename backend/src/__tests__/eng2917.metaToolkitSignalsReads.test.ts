jest.mock('../services/agentApiKeyService', () => ({ agentApiKeyService: {} }));
jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: {} }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../services/mcpUsageEventsService', () => ({ recordMcpToolUse: jest.fn(), recordMcpWriteExecuted: jest.fn() }));
jest.mock('../services/agentModeService', () => ({ agentModeService: { readToolkitMetaSignals: jest.fn().mockResolvedValue({ data: [] }) } }));
import { executeSignalsRead, SIGNAL_READ_DEFINITIONS, SIGNAL_FIELDS } from '../mcp/metaToolkitSignals';
import { getMetaToolkitManifest } from '../mcp/metaToolkitManifest';
import { handleMetaToolkitCall, stripCredentials } from '../mcp/metaToolkitGateway';
import { agentModeService } from '../services/agentModeService';
const credentials = { accountId: '123', accessToken: 'secret' };
describe('ENG-2917 signals reads', () => {
  beforeEach(() => jest.clearAllMocks());
  it.each(SIGNAL_READ_DEFINITIONS.map(d => [d.name]))('%s is advertised and works with only read scope', async name => {
    expect(getMetaToolkitManifest().some(d => d.name === name)).toBe(true);
    const recordWrite = jest.fn();
    const recordUsage = jest.fn();
    await handleMetaToolkitCall({ authorization: 'Bearer aw_fixture', toolName: name }, {
      validateApiKey: jest.fn().mockResolvedValue({ userId: 'u1', keyId: 'k1', scopes: ['tools:read'] }),
      listAccounts: jest.fn().mockResolvedValue([{ platform: 'meta', account_id: '123', config: { account_type: 'ad_account', ad_account_id: '123', access_token: 'x' } }]),
      recordUsage, recordWrite, now: () => 0,
      rateLimiter: { check: () => ({ allowed: true }) },
    } as any);
    expect(agentModeService.readToolkitMetaSignals).toHaveBeenCalledWith('u1', name, { account_id: '123' });
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordWrite).not.toHaveBeenCalled();
  });
  it('does not meter a signals read that Meta failed (success:false)', async () => {
    (agentModeService.readToolkitMetaSignals as jest.Mock).mockResolvedValueOnce({ success: false, errorClass: 'upstream_5xx' });
    const recordUsage = jest.fn();
    const result = await handleMetaToolkitCall({ authorization: 'Bearer aw_fixture', toolName: 'ads_get_datasets' }, {
      validateApiKey: jest.fn().mockResolvedValue({ userId: 'u1', keyId: 'k1', scopes: ['tools:read'] }),
      listAccounts: jest.fn().mockResolvedValue([{ platform: 'meta', account_id: '123', config: { account_type: 'ad_account', ad_account_id: '123', access_token: 'x' } }]),
      recordUsage, recordWrite: jest.fn(), now: () => 0,
      rateLimiter: { check: () => ({ allowed: true }) },
    } as any);
    expect((result as any).success).toBe(false);
    expect(recordUsage).not.toHaveBeenCalled();
  });
  it.each([
    ['ads_get_datasets', 'act_123/adspixels', SIGNAL_FIELDS.datasets],
    ['ads_get_customconversions', 'act_123/customconversions', SIGNAL_FIELDS.conversions],
    ['ads_get_dataset_details', '456', SIGNAL_FIELDS.details],
    ['ads_get_dataset_stats', '456/stats', undefined],
    ['ads_pixel_event_read', '456/event_rules', undefined],
  ])('%s requests the correct path and fields', async (name, path, fields) => {
    const get = jest.fn().mockResolvedValue({ data: { data: [{ id: '456' }] } });
    const args = ['ads_get_datasets', 'ads_get_customconversions'].includes(name!) ? {} : { pixel_id: '456' };
    await executeSignalsRead(name!, args, credentials, { get } as any);
    expect(get).toHaveBeenLastCalledWith(expect.stringContaining('/' + path), expect.objectContaining({ params: expect.objectContaining({ access_token: 'secret', ...(fields ? { fields } : {}) }) }));
  });
  it('passes stats aggregation and time range', async () => {
    const get = jest.fn().mockResolvedValue({ data: { data: [{ id: '456' }] } });
    await executeSignalsRead('ads_get_dataset_stats', { pixel_id: '456', aggregation: 'event', start_time: '123', end_time: '234' }, credentials, { get } as any);
    expect(get.mock.calls[1][1].params).toEqual({ access_token: 'secret', aggregation: 'event', start_time: '123', end_time: '234' });
  });
  it('paginates ownership with cursors rather than untrusted next URLs', async () => {
    const get = jest.fn().mockResolvedValueOnce({ data: { data: [], paging: { next: 'https://untrusted.invalid', cursors: { after: 'next-page' } } } }).mockResolvedValue({ data: { data: [{ id: '456' }] } });
    await executeSignalsRead('ads_get_dataset_details', { pixel_id: '456' }, credentials, { get } as any);
    expect(get.mock.calls[1][1].params.after).toBe('next-page');
    expect(get).toHaveBeenCalledTimes(3);
  });
  it('denies keys without read scope before account resolution', async () => {
    const listAccounts = jest.fn();
    await expect(handleMetaToolkitCall({ authorization: 'Bearer aw_fixture', toolName: 'ads_get_datasets' }, {
      validateApiKey: jest.fn().mockResolvedValue({ userId: 'u1', keyId: 'k1', scopes: ['email:read'] }),
      listAccounts, now: () => 0, rateLimiter: { check: () => ({ allowed: true }) },
    } as any)).rejects.toMatchObject({ status: 403 });
    expect(listAccounts).not.toHaveBeenCalled();
    expect(agentModeService.readToolkitMetaSignals).not.toHaveBeenCalled();
  });
  it('refuses foreign pixels before node reads', async () => {
    const get = jest.fn().mockResolvedValue({ data: { data: [] } });
    await expect(executeSignalsRead('ads_get_dataset_stats', { pixel_id: '456' }, credentials, { get } as any)).rejects.toThrow('not in the selected');
    expect(get).toHaveBeenCalledTimes(1);
  });
  it.each([{ pixel_id: '../me' }, { pixel_id: '456', access_token: 'evil' }, { pixel_id: '456', limit: 0 }])('rejects invalid input before Graph calls', async args => {
    const get = jest.fn();
    await expect(executeSignalsRead('ads_pixel_event_read', args, credentials, { get } as any)).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });
  it.each(['ads_get_datasets', 'ads_pixel_event_read'])('%s never returns a Graph paging URL (it carries the access token); cursors are kept', async (name) => {
    const tokenPage = { data: [{ id: '456' }], paging: { cursors: { before: 'b', after: 'a' }, next: 'https://graph.facebook.com/v25.0/x?access_token=secret&after=a', previous: 'https://graph.facebook.com/v25.0/x?access_token=secret&before=b' } };
    const get = jest.fn().mockResolvedValue({ data: tokenPage });
    const out: any = await executeSignalsRead(name, name === 'ads_get_datasets' ? {} : { pixel_id: '456' }, credentials, { get } as any);
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(out.paging).toEqual({ cursors: { before: 'b', after: 'a' }, has_next: true, has_previous: true });
  });

  it('stripCredentials redacts tokens inside URL strings for every toolkit response (signals, experiments, registry reads)', () => {
    const out = stripCredentials({ paging: { next: 'https://graph.facebook.com/x?limit=5&access_token=EAAB123&after=c' }, note: 'ok' });
    expect(JSON.stringify(out)).not.toContain('EAAB123');
    expect(out.paging.next).toContain('access_token=[redacted]&after=c');
  });

  it.each([
    [{ pixel_id: '456', start_time: 'yesterday' }],
    [{ pixel_id: '456', start_time: '1767225600', end_time: '1767139200' }],
    [{ pixel_id: '456', toString: 'x' }],
  ])('rejects bad stats input %j before Graph calls', async (args) => {
    const get = jest.fn();
    await expect(executeSignalsRead('ads_get_dataset_stats', args, credentials, { get } as any)).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });

  it('treats blank optional strings as absent instead of forwarding them to Graph', async () => {
    const get = jest.fn().mockResolvedValue({ data: { data: [{ id: '456' }] } });
    await executeSignalsRead('ads_get_datasets', { after: '' }, credentials, { get } as any);
    expect(get.mock.calls[0][1].params).not.toHaveProperty('after');
    get.mockClear();
    await executeSignalsRead('ads_get_dataset_stats', { pixel_id: '456', start_time: '', end_time: ' ' }, credentials, { get } as any);
    const statsParams = get.mock.calls[get.mock.calls.length - 1][1].params;
    expect(statsParams).not.toHaveProperty('start_time');
    expect(statsParams).not.toHaveProperty('end_time');
  });
  it('refuses when resolved credentials belong to a different account', async () => {
    const get = jest.fn();
    await expect(executeSignalsRead('ads_get_datasets', { account_id: '999' }, credentials, { get } as any)).rejects.toThrow('do not match');
    expect(get).not.toHaveBeenCalled();
    await executeSignalsRead('ads_get_datasets', { account_id: 'act_123' }, credentials, { get: jest.fn().mockResolvedValue({ data: {} }) } as any);
  });
  it('returns Meta refusals and outages as an actionable result, never a throw or the token', async () => {
    const graphErr = (status: number, error?: any) => Object.assign(new Error(`Request failed with status code ${status}`), {
      response: { status, data: error ? { error } : {} }, config: { url: 'https://graph.facebook.com/x?access_token=secret' },
    });
    const ok = jest.fn().mockResolvedValue({ data: { data: [{ id: '456' }] } });
    const refused = await executeSignalsRead('ads_pixel_event_read', { pixel_id: '456' }, credentials, {
      get: jest.fn().mockImplementationOnce(ok).mockRejectedValueOnce(graphErr(400, { code: 100, message: 'Unsupported get request.' })),
    } as any);
    expect(refused).toMatchObject({ success: false, error: 'Unsupported get request.', errorClass: 'upstream_rejected', metaErrorCode: 100 });
    const outage = await executeSignalsRead('ads_get_datasets', {}, credentials, { get: jest.fn().mockRejectedValue(graphErr(500)) } as any);
    expect(outage).toMatchObject({ success: false, errorClass: 'upstream_5xx' });
    expect(JSON.stringify([refused, outage])).not.toContain('secret');
  });

  it('retries one transient Meta failure before returning the read (Opslane P2)', async () => {
    const get = jest.fn().mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 500'), { response: { status: 500, data: {} } })).mockResolvedValueOnce({ data: { data: [{ id: '1' }] } });
    await expect(executeSignalsRead('ads_get_datasets', {}, credentials, { get } as any)).resolves.toEqual({ data: [{ id: '1' }] });
    expect(get).toHaveBeenCalledTimes(2);
  });
});
