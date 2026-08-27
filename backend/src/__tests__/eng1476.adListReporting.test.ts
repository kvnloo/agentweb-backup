jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({ isReady: jest.fn().mockReturnValue(true) }))
}));

jest.mock('../services/metaService', () => ({
  metaService: { listAds: jest.fn(), listAdCreatives: jest.fn() },
  MetaService: {},
}));

jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));

jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-access-token')
}));

import { AgentModeService } from '../services/agentModeService';
import { metaService } from '../services/metaService';
import { userDb } from '../services/db';

/**
 * ENG-1476 / ENG-1584 — the reporting half.
 *
 * `metaService.listAds` now reports truncation honestly, but that is only worth anything if the
 * layer the model actually reads says so too. The sentence that reached an Every.io customer was
 * built here:
 *
 *   "Found 25 ad(s)"  ->  the model concluded "I searched all 25 account ads: zero matches"
 *
 * A bare count with no scope and no bound reads as "these are all the ads". These tests pin that
 * every list result states BOTH what it was scoped to and whether it is complete, and that a
 * truncated list says so in the message the model sees — not only in a field it might ignore.
 */
describe('ENG-1476 listMetaAdsAds — the message must carry scope and completeness', () => {
  let agentModeService: AgentModeService;

  const mockUser = {
    id: 'user123',
    connected_accounts: [{
      platform: 'meta',
      account_id: '123456789',
      account_name: 'Test Business',
      config: { account_type: 'ad_account', access_token: 'mock-access-token', ad_account_id: '123456789' }
    }]
  };

  const listAdsReturns = (over: any = {}) =>
    (metaService.listAds as jest.Mock).mockResolvedValue({
      ads: [{ id: 'ad_1' }, { id: 'ad_2' }], truncated: false, pagesFetched: 1, scope: {}, ...over
    });

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
    (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
  });

  it('names the campaign it was scoped to', async () => {
    listAdsReturns({ scope: { campaignId: '120240930011430395' } });

    const result = await agentModeService.listMetaAdsAds('user123', undefined, undefined, '120240930011430395');

    expect(result.message).toContain('in campaign 120240930011430395');
    expect(result.message).toContain('complete list');
    expect(result.complete).toBe(true);
    expect(result.hasMore).toBe(false);
  });

  it('says "in this ad account" when nothing was scoped, so the breadth is explicit', async () => {
    listAdsReturns();
    const result = await agentModeService.listMetaAdsAds('user123');
    expect(result.message).toBe('Found 2 ad(s) in this ad account (complete list).');
  });

  it('a truncated list says INCOMPLETE in the message, not just in a field', async () => {
    listAdsReturns({ truncated: true, pagesFetched: 25 });

    const result = await agentModeService.listMetaAdsAds('user123');

    expect(result.complete).toBe(false);
    expect(result.hasMore).toBe(true);
    expect(result.message).toContain('INCOMPLETE');
    // The specific instruction that would have prevented ENG-1584's false statement.
    expect(result.message).toContain('Do NOT conclude an ad is absent');
    expect(result.message).not.toContain('complete list');
  });

  /**
   * A large ad list is offloaded to S3 and the model is handed a SEALED 20,000-char PREFIX of
   * this JSON. Any field serialized after the `ads` array is simply not there. If the
   * truncation warning sits behind the payload it vanishes on exactly the lists that need it.
   */
  it('serializes completeness BEFORE the ads array so it survives the S3 preview cut', async () => {
    listAdsReturns({ truncated: true });

    const json = JSON.stringify(await agentModeService.listMetaAdsAds('user123'));

    expect(json.indexOf('"complete"')).toBeGreaterThan(-1);
    expect(json.indexOf('"complete"')).toBeLessThan(json.indexOf('"ads"'));
    expect(json.indexOf('"hasMore"')).toBeLessThan(json.indexOf('"ads"'));
    expect(json.indexOf('"totalCount"')).toBeLessThan(json.indexOf('"ads"'));
    expect(json.indexOf('"message"')).toBeLessThan(json.indexOf('"ads"'));
  });

  it('forwards campaign_id to the service instead of dropping it', async () => {
    listAdsReturns({ scope: { campaignId: 'camp_1' } });

    await agentModeService.listMetaAdsAds('user123', undefined, undefined, 'camp_1');

    expect(metaService.listAds).toHaveBeenCalledWith(
      '123456789', 'mock-access-token', undefined, { campaignId: 'camp_1' }
    );
  });
});

describe('ENG-1476 manageMetaAdsAds — campaign_id must survive the dispatch', () => {
  let agentModeService: AgentModeService;

  const mockUser = {
    id: 'user123',
    connected_accounts: [{
      platform: 'meta',
      account_id: '123456789',
      account_name: 'Test Business',
      config: { account_type: 'ad_account', access_token: 'mock-access-token', ad_account_id: '123456789' }
    }]
  };

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
    (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
    (metaService.listAds as jest.Mock).mockResolvedValue({
      ads: [], truncated: false, pagesFetched: 1, scope: {}
    });
  });

  it('passes campaign_id through from the top-level argument', async () => {
    // This is the exact hop where it used to vanish: manageMetaAdsAds had no campaign_id
    // parameter at all, so an explicitly campaign-scoped LIST became account-wide.
    await agentModeService.manageMetaAdsAds('user123', 'LIST', '123456789', undefined, undefined, {}, 'camp_1');

    expect(metaService.listAds).toHaveBeenCalledWith(
      '123456789', 'mock-access-token', undefined, { campaignId: 'camp_1' }
    );
  });

  it('also accepts campaign_id nested in params, since callers use both spellings', async () => {
    await agentModeService.manageMetaAdsAds('user123', 'LIST', '123456789', undefined, undefined, { campaign_id: 'camp_2' });

    expect(metaService.listAds).toHaveBeenCalledWith(
      '123456789', 'mock-access-token', undefined, { campaignId: 'camp_2' }
    );
  });

  it('prefers the narrower ad set scope when both are supplied', async () => {
    await agentModeService.manageMetaAdsAds('user123', 'LIST', '123456789', 'adset_9', undefined, {}, 'camp_1');

    expect(metaService.listAds).toHaveBeenCalledWith(
      '123456789', 'mock-access-token', 'adset_9', { campaignId: 'camp_1' }
    );
  });
});
