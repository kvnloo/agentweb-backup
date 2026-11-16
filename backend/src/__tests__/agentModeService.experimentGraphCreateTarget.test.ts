/**
 * ENG-2980: Meta creates ad studies only on a Business or User `ad_studies` edge (the
 * ad-account edge is read-only), so an A/B create addressed to `act_<id>/ad_studies` must be
 * sent to the account's owning business, or the token's user when the account has none.
 */
jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({ isReady: jest.fn().mockReturnValue(true) })),
}));
jest.mock('../services/slackService', () => ({}));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));
jest.mock('axios');

import axios from 'axios';
import { AgentModeService } from '../services/agentModeService';

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('toolkitMetaExperimentGraph create target', () => {
  let svc: any;
  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(AgentModeService.prototype as any, 'getMetaCredentials')
      .mockResolvedValue({ accountId: '123', accessToken: 'tok' });
    svc = new AgentModeService();
    (mockedAxios.request as any) = jest.fn().mockResolvedValue({ data: { id: '999' } });
  });

  it("POSTs the create to the account's business ad_studies edge", async () => {
    (mockedAxios.get as any) = jest.fn().mockResolvedValue({ data: { business: { id: '555' } } });
    const res = await svc.toolkitMetaExperimentGraph('u1', '123', 'POST', 'act_123/ad_studies', { type: 'SPLIT_TEST' });
    expect(res).toEqual({ id: '999' });
    expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringMatching(/\/act_123$/), expect.objectContaining({ params: expect.objectContaining({ fields: 'business{id}' }) }));
    expect((mockedAxios.request as jest.Mock).mock.calls[0][0].url).toMatch(/\/555\/ad_studies$/);
  });

  it('falls back to the user edge when the account has no business', async () => {
    (mockedAxios.get as any) = jest.fn().mockResolvedValue({ data: { id: 'act_123' } });
    await svc.toolkitMetaExperimentGraph('u1', '123', 'POST', 'act_123/ad_studies', { type: 'SPLIT_TEST' });
    expect((mockedAxios.request as jest.Mock).mock.calls[0][0].url).toMatch(/\/me\/ad_studies$/);
  });

  it('reads and updates still use the given path, with no business lookup', async () => {
    (mockedAxios.get as any) = jest.fn();
    await svc.toolkitMetaExperimentGraph('u1', '123', 'GET', 'act_123/ad_studies', { fields: 'id' });
    await svc.toolkitMetaExperimentGraph('u1', '123', 'POST', '777', { name: 'x' });
    const urls = (mockedAxios.request as jest.Mock).mock.calls.map((c) => c[0].url);
    expect(urls[0]).toMatch(/\/act_123\/ad_studies$/);
    expect(urls[1]).toMatch(/\/777$/);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('refuses a create on another account', async () => {
    await expect(svc.toolkitMetaExperimentGraph('u1', '123', 'POST', 'act_456/ad_studies', {})).rejects.toThrow('Account mismatch.');
    expect(mockedAxios.request).not.toHaveBeenCalled();
  });
});
