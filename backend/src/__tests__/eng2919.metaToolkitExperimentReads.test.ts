jest.mock('../services/agentApiKeyService', () => ({ agentApiKeyService: {} }));
jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: {} }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../services/mcpUsageEventsService', () => ({ recordMcpToolUse: jest.fn(), recordMcpWriteExecuted: jest.fn() }));
jest.mock('../services/agentModeService', () => ({ agentModeService: { readToolkitMetaExperiments: jest.fn().mockResolvedValue({ data: [] }) } }));
import { executeExperimentRead, EXPERIMENT_READ_DEFINITIONS, EXPERIMENT_FIELDS } from '../mcp/metaToolkitExperiments';
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

describe('ENG-2919 experiment reads', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(EXPERIMENT_READ_DEFINITIONS.map((d) => [d.name]))('%s is advertised and works with only read scope, no write metering', async (name) => {
    expect(getMetaToolkitManifest().some((d: any) => d.name === name)).toBe(true);
    const recordWrite = jest.fn();
    const recordUsage = jest.fn();
    await handleMetaToolkitCall({ authorization: 'Bearer aw_fixture', toolName: name }, deps(['tools:read'], { recordUsage, recordWrite }));
    expect(agentModeService.readToolkitMetaExperiments).toHaveBeenCalledWith('u1', name, { account_id: '123' });
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordWrite).not.toHaveBeenCalled();
  });

  it('denies keys without read scope before account resolution', async () => {
    const d = deps(['email:read']);
    await expect(handleMetaToolkitCall({ authorization: 'Bearer aw_fixture', toolName: 'ads_experiment_list_tests' }, d)).rejects.toMatchObject({ status: 403 });
    expect(d.listAccounts).not.toHaveBeenCalled();
    expect(agentModeService.readToolkitMetaExperiments).not.toHaveBeenCalled();
  });

  it('lists ad studies on the selected account with list fields and paging', async () => {
    const get = jest.fn().mockResolvedValue({ data: { data: [] } });
    await executeExperimentRead('ads_experiment_list_tests', { limit: 10, after: 'c1' }, credentials, { get } as any);
    expect(get).toHaveBeenCalledWith(expect.stringMatching(/\/act_123\/ad_studies$/), expect.objectContaining({
      params: { fields: EXPERIMENT_FIELDS.list, limit: 10, after: 'c1', access_token: 'secret' },
    }));
  });

  it.each([
    ['ads_experiment_abtest_get_test', 'SPLIT_TEST'],
    ['ads_experiment_lift_get_test', 'LIFT'],
  ])('%s proves ownership then reads the study node', async (name, type) => {
    const get = jest.fn()
      .mockResolvedValueOnce({ data: { data: [{ id: '456' }] } })
      .mockResolvedValueOnce({ data: { id: '456', type } });
    const out = await executeExperimentRead(name, { study_id: '456' }, credentials, { get } as any);
    expect(out).toEqual({ id: '456', type });
    expect(get.mock.calls[0][0]).toMatch(/\/act_123\/ad_studies$/);
    expect(get.mock.calls[1][0]).toMatch(/\/456$/);
    expect(get.mock.calls[1][1].params.fields).toBe(EXPERIMENT_FIELDS.detail);
  });

  it('refuses a study of the other type', async () => {
    const get = jest.fn()
      .mockResolvedValueOnce({ data: { data: [{ id: '456' }] } })
      .mockResolvedValueOnce({ data: { id: '456', type: 'LIFT' } });
    await expect(executeExperimentRead('ads_experiment_abtest_get_test', { study_id: '456' }, credentials, { get } as any)).rejects.toThrow('not SPLIT_TEST');
  });

  it('refuses foreign studies before node reads', async () => {
    const get = jest.fn().mockResolvedValue({ data: { data: [] } });
    await expect(executeExperimentRead('ads_experiment_lift_get_test', { study_id: '456' }, credentials, { get } as any)).rejects.toThrow('not in the selected');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('paginates ownership with cursors rather than untrusted next URLs', async () => {
    const get = jest.fn()
      .mockResolvedValueOnce({ data: { data: [], paging: { next: 'https://untrusted.invalid', cursors: { after: 'p2' } } } })
      .mockResolvedValueOnce({ data: { data: [{ id: '456' }] } })
      .mockResolvedValueOnce({ data: { id: '456', type: 'LIFT' } });
    await executeExperimentRead('ads_experiment_lift_get_test', { study_id: '456' }, credentials, { get } as any);
    expect(get.mock.calls[1][1].params.after).toBe('p2');
    expect(get).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['ads_experiment_abtest_get_test', { study_id: '../me' }],
    ['ads_experiment_abtest_get_test', { study_id: '456', access_token: 'evil' }],
    ['ads_experiment_list_tests', { limit: 0 }],
    ['ads_experiment_list_tests', { study_id: '456' }],
  ])('%s rejects invalid input %o before Graph calls', async (name, args) => {
    const get = jest.fn();
    await expect(executeExperimentRead(name as string, args, credentials, { get } as any)).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });

  it('treats blank optional strings as absent', async () => {
    const get = jest.fn().mockResolvedValue({ data: { data: [] } });
    await executeExperimentRead('ads_experiment_list_tests', { after: ' ' }, credentials, { get } as any);
    expect(get.mock.calls[0][1].params).not.toHaveProperty('after');
  });
});
