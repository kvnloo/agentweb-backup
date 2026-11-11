/**
 * ENG-2913 (Opslane P1): a creative swap's ownership check must not report "not in the ad
 * account" when Meta merely failed the lookup. Meta code 100 (node missing / not visible) is a
 * real "not found"; any other failure is tagged creativeLookupFailed.
 */
jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({ isReady: jest.fn().mockReturnValue(true) })),
}));
jest.mock('../services/adminAuditLog', () => ({ recordAdminAudit: jest.fn() }));

import { AgentModeService } from '../services/agentModeService';
import { metaService } from '../services/metaService';

describe('ENG-2913 assertToolkitMetaCreativeOwned', () => {
  const service = new AgentModeService();
  beforeEach(() => {
    jest.spyOn(service as any, 'getMetaCredentials').mockResolvedValue({ accountId: '111', accessToken: 't' });
  });
  afterEach(() => jest.restoreAllMocks());

  it('a transient Meta failure is a failed lookup, not a verdict', async () => {
    jest.spyOn(metaService, 'getAdCreative').mockRejectedValue(Object.assign(new Error('Service temporarily unavailable'), { structuredError: { code: 2 } }));
    await expect(service.assertToolkitMetaCreativeOwned('u1', '111', '200')).rejects.toMatchObject({ creativeLookupFailed: true });
  });

  it('Meta code 100 (missing / not visible) stays a not-found error', async () => {
    jest.spyOn(metaService, 'getAdCreative').mockRejectedValue(Object.assign(new Error('Unsupported get request'), { structuredError: { code: 100 } }));
    const err: any = await service.assertToolkitMetaCreativeOwned('u1', '111', '200').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.creativeLookupFailed).toBeUndefined();
  });

  it('a creative owned by another ad account is refused; the selected account passes', async () => {
    jest.spyOn(metaService, 'getAdCreative').mockResolvedValue({ id: '200', account_id: '999' } as any);
    await expect(service.assertToolkitMetaCreativeOwned('u1', '111', '200')).rejects.toThrow();
    jest.spyOn(metaService, 'getAdCreative').mockResolvedValue({ id: '200', account_id: 'act_111' } as any);
    await expect(service.assertToolkitMetaCreativeOwned('u1', '111', '200')).resolves.toBeUndefined();
  });
});
