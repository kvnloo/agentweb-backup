/**
 * ENG-918 (skill-wiring gap follow-up) — get_ads_thresholds, the Emma tool that lets a skill
 * read the resolved per-client thresholds instead of a hardcoded percentage.
 *
 * Mirrors GET /api/ads-thresholds/:platform/:accountId (routes/adsThresholds.ts, covered
 * exhaustively in eng918.adsThresholdsRoutes.test.ts) exactly — same ownership check, same
 * service calls — so this file focuses on proving the tool wraps that logic correctly rather
 * than re-testing the store's own rules a third time.
 */

jest.mock('../services/agentModeService', () => ({
  agentModeService: {},
}));

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
}));

jest.mock('../services/adsThresholdsDb', () => ({
  getThresholdsForAccount: jest.fn(),
}));

import { emmaToolRegistry } from '../emma/registry';
import { userDb } from '../services/db';
import { getThresholdsForAccount } from '../services/adsThresholdsDb';

// Import tools.ts to ensure tools are registered
import '../emma/tools';

const OWNED = '1842363582956923';
const NOT_OWNED = '9999999999999999';

function ownerWith(accountId: string) {
  return {
    userId: 'caller-1',
    connected_accounts: [
      {
        platform: 'meta',
        account_id: `act_${accountId}`,
        config: { account_type: 'ad_account', access_token: 'tok' },
      },
    ],
  };
}

describe('Emma Tools - get_ads_thresholds', () => {
  const toolName = 'get_ads_thresholds';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is registered in emmaToolRegistry', () => {
    const tool = emmaToolRegistry.getTool(toolName);
    expect(tool).toBeDefined();
    expect(tool?.definition.name).toBe(toolName);
  });

  it('rejects a non-meta platform without touching the store', async () => {
    const tool = emmaToolRegistry.getTool(toolName);
    if (!tool) throw new Error(`Tool ${toolName} not found`);

    const result = await tool.execute({ platform: 'google', account_id: OWNED }, { userId: 'caller-1' });

    expect(result).toEqual(expect.objectContaining({ success: false, error: expect.stringMatching(/not supported yet/i) }));
    expect(getThresholdsForAccount).not.toHaveBeenCalled();
  });

  it('refuses an ad account the caller does not own, before touching the store', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(ownerWith(OWNED));

    const tool = emmaToolRegistry.getTool(toolName);
    if (!tool) throw new Error(`Tool ${toolName} not found`);

    const result = await tool.execute({ platform: 'meta', account_id: NOT_OWNED }, { userId: 'caller-1' });

    expect(result).toEqual(expect.objectContaining({ success: false, error: expect.stringMatching(/not one of your connected accounts/i) }));
    expect(getThresholdsForAccount).not.toHaveBeenCalled();
  });

  // ENG-2938: prod failures were the model passing a well-formed-but-unnormalized id or the name.
  it.each([
    [`act_${OWNED}`], [` ACT_${OWNED} `], [Number(OWNED) as any], ['Main Account'],
  ])('resolves an owned account passed as %p', async (accountArg) => {
    const user = ownerWith(OWNED) as any;
    user.connected_accounts[0].account_name = 'Main Account';
    (userDb.getUserById as jest.Mock).mockResolvedValue(user);
    (getThresholdsForAccount as jest.Mock).mockResolvedValue([]);
    const tool = emmaToolRegistry.getTool(toolName)!;
    const result = await tool.execute({ platform: 'meta', account_id: accountArg }, { userId: 'caller-1' });
    expect(result.success).toBe(true);
    expect(result.account_id).toBe(OWNED);
    expect(getThresholdsForAccount).toHaveBeenCalledWith('meta', OWNED);
  });

  it('lists the valid connected ids when the account is not owned', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(ownerWith(OWNED));
    const tool = emmaToolRegistry.getTool(toolName)!;
    const result = await tool.execute({ platform: 'meta', account_id: NOT_OWNED }, { userId: 'caller-1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain(OWNED);
  });

  it('says no Meta account is connected rather than an ownership error', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'caller-1', connected_accounts: [] });
    const tool = emmaToolRegistry.getTool(toolName)!;
    const result = await tool.execute({ platform: 'meta', account_id: OWNED }, { userId: 'caller-1' });
    expect(result.error).toMatch(/No Meta ad account is connected/);
  });

  it('returns the resolved set (registry defaults) for an owned account with no overrides', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(ownerWith(OWNED));
    (getThresholdsForAccount as jest.Mock).mockResolvedValue([]);

    const tool = emmaToolRegistry.getTool(toolName);
    if (!tool) throw new Error(`Tool ${toolName} not found`);

    const result = await tool.execute({ platform: 'meta', account_id: OWNED }, { userId: 'caller-1' });

    expect(result.success).toBe(true);
    expect(result.account_id).toBe(OWNED);
    const ctr = result.parameters.find((p: any) => p.key === 'creativeFatigue.ctrDropCriticalPct');
    expect(ctr).toEqual(expect.objectContaining({ value: 20, source: 'default', defaultValue: 20 }));
    const freq = result.parameters.find((p: any) => p.key === 'creativeFatigue.frequencyCritical');
    expect(freq).toEqual(expect.objectContaining({ value: 3.5, source: 'default' }));
    // All 6 registry parameters present, not a partial set.
    expect(result.parameters).toHaveLength(6);
  });

  it('surfaces a customized (source: user) value over the registry default', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(ownerWith(OWNED));
    (getThresholdsForAccount as jest.Mock).mockResolvedValue([
      {
        paramKey: 'creativeFatigue.ctrDropCriticalPct',
        currentValue: 25,
        source: 'user',
        revisions: [],
      },
    ]);

    const tool = emmaToolRegistry.getTool(toolName);
    if (!tool) throw new Error(`Tool ${toolName} not found`);

    const result = await tool.execute({ platform: 'meta', account_id: OWNED }, { userId: 'caller-1' });

    const ctr = result.parameters.find((p: any) => p.key === 'creativeFatigue.ctrDropCriticalPct');
    expect(ctr).toEqual(expect.objectContaining({ value: 25, source: 'user', defaultValue: 20 }));
  });

  it('cleans an act_-prefixed account_id the same way the route does', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(ownerWith(OWNED));
    (getThresholdsForAccount as jest.Mock).mockResolvedValue([]);

    const tool = emmaToolRegistry.getTool(toolName);
    if (!tool) throw new Error(`Tool ${toolName} not found`);

    const result = await tool.execute({ platform: 'meta', account_id: `act_${OWNED}` }, { userId: 'caller-1' });

    expect(result.success).toBe(true);
    expect(result.account_id).toBe(OWNED);
    expect(getThresholdsForAccount).toHaveBeenCalledWith('meta', OWNED);
  });
});

jest.mock('../services/adsLearningDb', () => ({ getScopedLearning: jest.fn() }));
import { getScopedLearning } from '../services/adsLearningDb';
it('retrieves scoped guidance only when requested, using the authenticated client', async () => {
  (userDb.getUserById as jest.Mock).mockResolvedValue(ownerWith(OWNED));
  (getThresholdsForAccount as jest.Mock).mockResolvedValue([]);
  (getScopedLearning as jest.Mock).mockResolvedValue([{ content: 'fixture guidance' }]);
  const tool = emmaToolRegistry.getTool('get_ads_thresholds')!;
  const result = await tool.execute({ platform: 'meta', account_id: OWNED, include_learning: true, campaign_id: 'campaign' }, { userId: 'caller-1' });
  expect(result.learning).toEqual([{ content: 'fixture guidance' }]);
  expect(getScopedLearning).toHaveBeenCalledWith(expect.objectContaining({ userId: 'caller-1', campaignId: 'campaign', accountId: OWNED }));
});
it('keeps parameter output usable and marks guidance unavailable on retrieval failure', async () => {
  (userDb.getUserById as jest.Mock).mockResolvedValue(ownerWith(OWNED));
  (getThresholdsForAccount as jest.Mock).mockResolvedValue([]);
  (getScopedLearning as jest.Mock).mockRejectedValue(new Error('offline'));
  const tool = emmaToolRegistry.getTool('get_ads_thresholds')!;
  const baseline = await tool.execute({ platform: 'meta', account_id: OWNED }, { userId: 'caller-1' });
  const result = await tool.execute({ platform: 'meta', account_id: OWNED, include_learning: true }, { userId: 'caller-1' });
  expect(result).toEqual({ ...baseline, learningUnavailable: true });
});
