/**
 * ENG-2575: call_linkedin_marketing_api CREATIVE UPDATE was advertised in the
 * action enum but threw `Unknown action "UPDATE" for CREATIVE`, so an agent
 * could never pause/archive a LinkedIn ad (prod failure 2026-10-16).
 */
const mockAxiosFn = jest.fn();
jest.mock('axios', () => {
  const fn = (...args: any[]) => mockAxiosFn(...args);
  (fn as any).post = jest.fn();
  (fn as any).get = jest.fn();
  (fn as any).create = jest.fn().mockReturnValue(fn);
  (fn as any).interceptors = { request: { use: jest.fn() }, response: { use: jest.fn() } };
  (fn as any).isAxiosError = () => false;
  return { __esModule: true, default: fn };
});
jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({ isReady: jest.fn().mockReturnValue(true) })),
}));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));
jest.mock('../config/integrations', () => ({
  INTEGRATION_CONFIG: {
    linkedinAds: { apiVersion: '202603', tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken' },
  },
  getLinkedInAdsConfig: jest.fn().mockResolvedValue({ clientId: 'c', clientSecret: 's', tokenUrl: 'u' }),
}));
jest.mock('../services/connectedAccountsDb', () => ({
  updateAccountTokens: jest.fn().mockResolvedValue(undefined),
  getAccountsWithOwnerIncludingOrgShared: jest.fn(async (userId: string) => {
    const { userDb } = require('../services/db');
    const user = await userDb.getUserById(userId);
    return (user?.connected_accounts ?? []).map((a: any) => ({ ...a, userId }));
  }),
}));

import { AgentModeService } from '../services/agentModeService';
import { userDb } from '../services/db';

const USER_ID = 'user-123';
const ACCOUNT_ID = '556450004';

beforeEach(() => {
  jest.clearAllMocks();
  mockAxiosFn.mockResolvedValue({ data: {}, status: 204 });
  (userDb.getUserById as jest.Mock).mockResolvedValue({
    id: USER_ID,
    connected_accounts: [{
      platform: 'linkedin_ads',
      account_id: ACCOUNT_ID,
      config: {
        account_type: 'ad_account',
        access_token: 'tok',
        refresh_token: 'r',
        token_expires_at: Date.now() + 3_600_000,
        organization_urn: 'urn:li:organization:1',
      },
    }],
  });
});

const call = (params: any) =>
  new AgentModeService().callLinkedInMarketingApi(USER_ID, 'CREATIVE', 'UPDATE', ACCOUNT_ID, params);

describe('ENG-2575 CREATIVE UPDATE', () => {
  it('archives a creative via PARTIAL_UPDATE of intendedStatus (the prod-failing call)', async () => {
    const res: any = await call({ creative_id: '1644805286', status: 'ARCHIVED' });
    expect(res.success).toBe(true);
    expect(mockAxiosFn).toHaveBeenCalledTimes(1);
    const req = mockAxiosFn.mock.calls[0][0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe(
      `https://api.linkedin.com/rest/adAccounts/556450004/creatives/${encodeURIComponent('urn:li:sponsoredCreative:1644805286')}`,
    );
    expect(req.headers['X-RestLi-Method']).toBe('PARTIAL_UPDATE');
    expect(req.data).toEqual({ patch: { $set: { intendedStatus: 'ARCHIVED' } } });
  });

  it('accepts a full creative URN and normalises status case', async () => {
    await call({ creative_id: 'urn:li:sponsoredCreative:42', status: 'paused' });
    const req = mockAxiosFn.mock.calls[0][0];
    expect(req.url).toContain(encodeURIComponent('urn:li:sponsoredCreative:42'));
    expect(req.data.patch.$set.intendedStatus).toBe('PAUSED');
  });

  it('rejects a missing creative_id without calling LinkedIn', async () => {
    await expect(call({ status: 'PAUSED' })).rejects.toThrow(/creative_id/);
    expect(mockAxiosFn).not.toHaveBeenCalled();
  });

  it('rejects a missing or invalid status, listing allowed values, without calling LinkedIn', async () => {
    await expect(call({ creative_id: '1' })).rejects.toThrow(/ACTIVE, PAUSED, ARCHIVED, CANCELED, DRAFT/);
    await expect(call({ creative_id: '1', status: 'DELETED' })).rejects.toThrow(/params\.status/);
    expect(mockAxiosFn).not.toHaveBeenCalled();
  });
});
