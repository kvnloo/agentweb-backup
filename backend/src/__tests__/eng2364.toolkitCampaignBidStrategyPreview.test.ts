process.env.ZOMA_REQUIRE_PAYMENT_METHOD = 'true';
/**
 * ENG-2364 (Opslane P1 on #4271): the Toolkit CAMPAIGN UPDATE preview must list the
 * bid_strategy that updateCampaign adds when a budget lands on a campaign with no strategy,
 * and must not list one for a campaign that already has a strategy (e.g. COST_CAP).
 */
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../mcp/zomaOnboarding', () => {
  const actual = jest.requireActual('../mcp/zomaOnboarding');
  return { ...actual, assertZomaWriteReady: jest.fn() };
});

import { executeMetaToolkitWrite, type MetaToolkitWriteDeps } from '../mcp/metaToolkitWrites';
import { campaignBidStrategyDefault } from '../utils/metaCampaignBidStrategyDefault';

const account = {
  platform: 'meta', account_id: 'act_111',
  config: { account_type: 'ad_account', access_token: 'tok', ad_account_id: '111', granted_scopes: ['ads_read', 'ads_management'] },
};

function makeDeps(prior: Record<string, any> | null): MetaToolkitWriteDeps {
  return {
    assertReady: jest.fn().mockResolvedValue(undefined),
    listAccounts: jest.fn().mockResolvedValue([account]),
    previewMoney: jest.fn(async (_u: string, _a: string, params: any) => ({ params: { ...params }, currency: 'USD', confirmation: '' })),
    preview: jest.fn(async (_u: string, entity: string, action: string, accountId: string, c?: string, as?: string, ad?: string, params?: any) => ({
      success: true, awaitingUserConfirmation: true, summary: `${action} ${entity}`,
      metaWriteDispatch: { entity_type: entity, action, account_id: accountId, campaign_id: c, ad_set_id: as, ad_id: ad, params },
    })),
    dispatch: jest.fn(),
    readBack: jest.fn().mockResolvedValue(prior),
    assertCreativeOwned: jest.fn().mockResolvedValue(undefined),
    spendCeilingPolicy: () => null,
    secret: () => 'test-secret',
    now: () => 1_800_000_000_000,
    consumedTokens: new Map(),
  } as unknown as MetaToolkitWriteDeps;
}

const budgetUpdate = { entity_type: 'CAMPAIGN', action: 'UPDATE', account_id: '111', campaign_id: '42', params: { daily_budget: 5000 } };

describe('Toolkit CAMPAIGN UPDATE preview shows the default bid_strategy (ENG-2364)', () => {
  it('no-strategy, no-budget campaign: preview lists bid_strategy (not set) → LOWEST_COST_WITHOUT_CAP', async () => {
    const res: any = await executeMetaToolkitWrite('u1', budgetUpdate, makeDeps({ id: '42', status: 'PAUSED' }));
    expect(res.status).toBe('PREVIEW');
    expect(res.preview).toContain('- bid_strategy: (not set) → LOWEST_COST_WITHOUT_CAP');
  });

  it('COST_CAP campaign: preview lists no bid_strategy change', async () => {
    const res: any = await executeMetaToolkitWrite('u1', budgetUpdate, makeDeps({ id: '42', status: 'PAUSED', bid_strategy: 'COST_CAP' }));
    expect(res.status).toBe('PREVIEW');
    expect(res.preview).not.toContain('bid_strategy');
  });

  it('preview and write agree: the helper both use', () => {
    expect(campaignBidStrategyDefault({ daily_budget: 5000 }, {})).toBe('LOWEST_COST_WITHOUT_CAP');
    expect(campaignBidStrategyDefault({ daily_budget: 5000 }, { bid_strategy: 'COST_CAP' })).toBeUndefined();
    expect(campaignBidStrategyDefault({ daily_budget: 5000 }, { daily_budget: '3000' })).toBeUndefined();
    expect(campaignBidStrategyDefault({ name: 'x' }, {})).toBeUndefined();
  });
});
