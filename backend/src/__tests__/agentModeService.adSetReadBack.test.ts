jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    isReady: jest.fn().mockReturnValue(true)
  }))
}));

jest.mock('../services/metaService', () => {
  const actual = jest.requireActual('../services/metaService');
  return {
    ...actual,
    metaService: {
      getCampaign: jest.fn(),
      createAdSet: jest.fn(),
      getAdSet: jest.fn()
    }
  };
});

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() }
}));

jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-access-token')
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getMessagesFromMessagesTable: jest.fn().mockResolvedValue([]),
    getChatSession: jest.fn().mockResolvedValue(null),
    updateSessionAskUserQuestion: jest.fn().mockResolvedValue({}),
    createChatSession: jest.fn().mockResolvedValue({ sessionId: 'auto-created-session' })
  }
}));

import { AgentModeService } from '../services/agentModeService';
import { metaService } from '../services/metaService';
import { userDb } from '../services/db';

/**
 * ENG-838 acceptance criterion 4 — after a successful deploy, the applied bid
 * strategy, budget and schedule are read back from Meta and surfaced, so a
 * wrong write is visible in-product.
 *
 * PR #2244 shipped AC 1-3 (the contract fix and the fail-loud dayparting
 * guard). What it deliberately did NOT ship is the read-back: today
 * `appliedBidStrategy` is the value this process *resolved*, never a value
 * re-read from the entity. That is the difference between reporting what we
 * intended and reporting what actually landed — and the Open Future Forum
 * shape (specified parameters, platform defaults applied, run reports success)
 * is invisible to the former and caught by the latter.
 */
const mockUser = {
  id: 'user123',
  connected_accounts: [
    {
      platform: 'meta',
      account_id: '123456789',
      account_name: 'Test Business',
      config: {
        account_type: 'ad_account',
        access_token: 'mock-access-token',
        ad_account_id: '123456789'
      }
    }
  ]
};

describe('ENG-838 AC4 — the applied ad set settings are read back from Meta, not assumed', () => {
  let service: AgentModeService;

  const baseAdSetParams = {
    name: 'Ad Set',
    campaign_id: 'camp_123',
    billing_event: 'IMPRESSIONS',
    optimization_goal: 'LINK_CLICKS',
    daily_budget: 10,
    targeting: { geo_locations: { countries: ['US'] } }
  };

  beforeEach(() => {
    service = new AgentModeService();
    jest.clearAllMocks();
    (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
    (metaService.getCampaign as jest.Mock).mockResolvedValue({
      id: 'camp_123',
      objective: 'OUTCOME_TRAFFIC'
    });
    (metaService.createAdSet as jest.Mock).mockResolvedValue({ id: 'adset_new', name: 'Ad Set' });
    // Default: Meta honoured exactly what we sent.
    (metaService.getAdSet as jest.Mock).mockResolvedValue({
      id: 'adset_new',
      name: 'Ad Set',
      bid_strategy: 'COST_CAP',
      bid_amount: '500',
      daily_budget: '1000',
      start_time: undefined,
      end_time: undefined
    });
  });

  it('reads the entity back after create and surfaces what Meta actually applied', async () => {
    const result = await service.createMetaAdsAdSet('user123', {
      ...baseAdSetParams,
      bid_strategy: 'COST_CAP',
      bid_amount: 5
    });

    expect(result.success).toBe(true);
    // The read-back is against the created entity, using the token we just used.
    expect(metaService.getAdSet).toHaveBeenCalledWith('mock-access-token', 'adset_new');
    // Surfaced values come from the entity, not from our own resolution.
    expect(result.readBack).toBeDefined();
    expect(result.readBack.bid_strategy).toBe('COST_CAP');
    expect(result.readBack.daily_budget).toBe('1000');
    expect(result.readBackMismatches).toEqual([]);
  });

  it('fails loudly and names the parameter when Meta applied something we did not ask for', async () => {
    // The Open Future Forum shape: the caller specified COST_CAP, the entity
    // came back on Meta's own default. Previously this returned a clean
    // success and nobody could tell.
    (metaService.getAdSet as jest.Mock).mockResolvedValue({
      id: 'adset_new',
      name: 'Ad Set',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      bid_amount: '500',
      daily_budget: '1000'
    });

    const result = await service.createMetaAdsAdSet('user123', {
      ...baseAdSetParams,
      bid_strategy: 'COST_CAP',
      bid_amount: 5
    });

    expect(result.success).toBe(false);
    expect(String(result.message)).toMatch(/bid_strategy/);
    expect(String(result.message)).toMatch(/COST_CAP/);
    expect(String(result.message)).toMatch(/LOWEST_COST_WITHOUT_CAP/);
    // The ad set exists — the caller must be told which one to go fix.
    expect(String(result.message)).toMatch(/adset_new/);
    expect(result.adSet).toBeDefined();
    expect(result.readBackMismatches).toEqual([
      { parameter: 'bid_strategy', requested: 'COST_CAP', applied: 'LOWEST_COST_WITHOUT_CAP' }
    ]);
  });

  it('catches a silently substituted budget the same way', async () => {
    (metaService.getAdSet as jest.Mock).mockResolvedValue({
      id: 'adset_new',
      name: 'Ad Set',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      daily_budget: '5000' // $50/day against a requested $10/day
    });

    const result = await service.createMetaAdsAdSet('user123', { ...baseAdSetParams });

    expect(result.success).toBe(false);
    expect(result.readBackMismatches).toEqual([
      { parameter: 'daily_budget', requested: '1000', applied: '5000' }
    ]);
  });

  it('reports a schedule that did not land', async () => {
    (metaService.getAdSet as jest.Mock).mockResolvedValue({
      id: 'adset_new',
      name: 'Ad Set',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      daily_budget: '1000',
      start_time: '2026-09-01T00:00:00+0000',
      end_time: undefined
    });

    const result = await service.createMetaAdsAdSet('user123', {
      ...baseAdSetParams,
      start_time: '2026-09-01T00:00:00+0000',
      end_time: '2026-09-30T00:00:00+0000'
    });

    expect(result.success).toBe(false);
    expect(result.readBackMismatches).toEqual([
      { parameter: 'end_time', requested: '2026-09-30T00:00:00+0000', applied: null }
    ]);
  });

  it('does not claim a verified write when the read-back itself failed', async () => {
    (metaService.getAdSet as jest.Mock).mockRejectedValue(new Error('Meta unreachable'));

    const result = await service.createMetaAdsAdSet('user123', { ...baseAdSetParams });

    // The ad set was created; saying otherwise would be a different lie. But
    // the result must not imply the settings were confirmed.
    expect(result.success).toBe(true);
    expect(result.readBackVerified).toBe(false);
    expect(String(result.readBackError)).toMatch(/Meta unreachable/);
    expect(result.readBackMismatches).toBeUndefined();
  });

  it('still reports the resolved strategy fields that PR #2244 added', async () => {
    (metaService.getAdSet as jest.Mock).mockResolvedValue({
      id: 'adset_new',
      name: 'Ad Set',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      daily_budget: '1000'
    });

    const result = await service.createMetaAdsAdSet('user123', { ...baseAdSetParams });

    expect(result.success).toBe(true);
    expect(result.appliedBidStrategy).toBe('LOWEST_COST_WITHOUT_CAP');
    expect(result.bidStrategyWasDefaulted).toBe(true);
    expect(result.readBackVerified).toBe(true);
  });
});
