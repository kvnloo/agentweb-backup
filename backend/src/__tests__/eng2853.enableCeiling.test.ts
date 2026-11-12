jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));

import { executeGoogleToolkitWrite, GoogleToolkitWriteDeps } from '../mcp/googleToolkitWrites';
import { executeMetaToolkitWrite, MetaToolkitWriteDeps } from '../mcp/metaToolkitWrites';
import { readBackMetaNode } from '../services/agentMode/metaToolkitSeams';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';

const campaign = 'customers/123/campaigns/1';
const budget = 'customers/123/campaignBudgets/2';
const group = 'customers/123/adGroups/3';

function fixture(platform: 'google' | 'meta', amount: unknown = 200) {
  const state: Record<string, any> = {
    [group]: { resourceName: group, campaign, status: 'PAUSED' },
    [campaign]: { resourceName: campaign, budget },
    [budget]: { resourceName: budget, amountMicros: amount },
    set: { id: 'set', daily_budget: amount, status: 'PAUSED', campaign_id: 'parent' },
    parent: { id: 'parent', daily_budget: amount },
  };
  const common = {
    assertReady: jest.fn().mockResolvedValue(undefined),
    spendCeilingPolicy: () => ({ maxDailyBudget: 100 }),
    secret: () => 'test-secret', now: () => 1800000000000, consumedTokens: new Map<string, number>(),
  };
  const dispatch = jest.fn(async () => {
    state[group].status = 'ENABLED'; state.set.status = 'ACTIVE';
    return { success: true, result: { success: true } };
  });
  const google: GoogleToolkitWriteDeps = { ...common, dispatch,
    read: jest.fn(async (_u, _c, _k, id) => state[id] ? { ...state[id] } : null),
  };
  const meta: MetaToolkitWriteDeps = { ...common, dispatch,
    listAccounts: jest.fn().mockResolvedValue([{ platform: 'meta', account_id: 'act_111', config: { account_type: 'ad_account', access_token: 'tok', ad_account_id: '111', granted_scopes: ['ads_management'] } }]),
    previewMoney: jest.fn(),
    preview: jest.fn().mockResolvedValue({ awaitingUserConfirmation: true, summary: 'Enable', metaWriteDispatch: {} }),
    readBack: jest.fn(async (_u, _a, _e, id) => state[id] ? { ...state[id] } : null),
    assertCreativeOwned: jest.fn().mockResolvedValue(undefined),
  };
  const args = platform === 'google'
    ? { entity_type: 'AD_GROUP', action: 'UPDATE', customer_id: '123', ad_group_resource_name: group, status: 'ENABLED' }
    : { entity_type: 'AD_SET', action: 'UPDATE', account_id: '111', ad_set_id: 'set', params: { status: 'ACTIVE' } };
  const run = (extra = {}) => platform === 'google'
    ? executeGoogleToolkitWrite('u', { ...args, ...extra }, 'USD', google)
    : executeMetaToolkitWrite('u', { ...args, ...extra }, meta);
  return { state, dispatch, run };
}

describe.each(['google', 'meta'] as const)('%s child enable ceiling', (platform) => {
  it('refuses over-ceiling enables with the existing refusal class before dispatch', async () => {
    const f = fixture(platform);
    await expect(f.run()).rejects.toBeInstanceOf(MetaToolkitRefusal);
    await expect(f.run({ confirm: true })).rejects.toThrow(/exceeds this account's max daily budget/);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('allows under-ceiling preview and confirmed dispatch unchanged', async () => {
    const f = fixture(platform, 50);
    const p: any = await f.run();
    expect(p.status).toBe('PREVIEW');
    expect(f.dispatch).not.toHaveBeenCalled();
    await expect(f.run({ confirm: true, preview_token: p.preview_token })).resolves.toMatchObject({ success: true, verification: 'CONFIRMED' });
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it('fails closed when the budget cannot be read', async () => {
    const f = fixture(platform, undefined);
    delete f.state[budget]; delete f.state.set.daily_budget; delete f.state.parent;
    await expect(f.run()).rejects.toThrow(/could not be evaluated/);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('rechecks the ceiling at confirmation', async () => {
    const f = fixture(platform, 50);
    const p: any = await f.run();
    f.state[budget].amountMicros = 200; f.state.set.daily_budget = 200;
    await expect(f.run({ confirm: true, preview_token: p.preview_token })).rejects.toThrow(/exceeds/);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('binds approval to an under-ceiling budget change', async () => {
    const f = fixture(platform, 50);
    const p: any = await f.run();
    f.state[budget].amountMicros = 75; f.state.set.daily_budget = 75;
    await expect(f.run({ confirm: true, preview_token: p.preview_token })).resolves.toMatchObject({ status: 'PREVIEW_MISMATCH' });
    expect(f.dispatch).not.toHaveBeenCalled();
  });
});

it('requests and preserves the provider parent campaign in Meta ad-set read-back', async () => {
  const reader = { listCampaigns: jest.fn(), getAd: jest.fn(), listAdSets: jest.fn().mockResolvedValue({ adSets: [{ id: 'set', campaign_id: 'parent' }] }) };
  await expect(readBackMetaNode(reader, '111', 'tok', 'AD_SET', 'set')).resolves.toMatchObject({ campaign_id: 'parent' });
  expect(reader.listAdSets).toHaveBeenCalledWith('111', 'tok', undefined, { adSetId: 'set', fields: expect.arrayContaining(['campaign_id']) });
});

it('checks the parent campaign budget for a Meta campaign-budgeted ad set', async () => {
  const f = fixture('meta');
  f.state.set.daily_budget = '0';
  await expect(f.run()).rejects.toThrow(/exceeds/);
  expect(f.dispatch).not.toHaveBeenCalled();
});
