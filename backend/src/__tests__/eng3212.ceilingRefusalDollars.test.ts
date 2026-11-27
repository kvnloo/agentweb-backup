/**
 * ENG-3212 — Google and X spend-ceiling refusals show money in the account currency (as
 * LinkedIn does), never raw micros. Display only: the caps themselves are unchanged.
 * Policy: at most 500.00 USD a day and at most 2x in one change; the current budget is 100.00 USD.
 */
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
jest.mock('../mcp/zomaOnboarding', () => ({
  assertZomaWriteReady: jest.fn(),
  ZomaNotReadyError: class ZomaNotReadyError extends Error {},
}));

import { executeGoogleToolkitWrite, type GoogleToolkitWriteDeps } from '../mcp/googleToolkitWrites';
import { executeXAdsWrite, type XAdsWriteDeps } from '../mcp/xAdsToolkitWrites';

const POLICY = { maxDailyBudget: 500_000_000, maxChangeRatio: 2 };
const PRIOR = 100_000_000;
const common = {
  assertReady: jest.fn().mockResolvedValue(undefined),
  spendCeilingPolicy: () => POLICY,
  secret: () => 'test-secret',
  now: () => 1800000000000,
};

const BUDGET = 'customers/123/campaignBudgets/2';
function google(amount: number) {
  const deps: GoogleToolkitWriteDeps = {
    ...common,
    consumedTokens: new Map(),
    read: jest.fn(async () => ({ resourceName: BUDGET, name: 'Daily', amountMicros: PRIOR, explicitlyShared: false, referenceCount: 1 })),
    dispatch: jest.fn(),
  };
  return executeGoogleToolkitWrite('u1', { customer_id: '123', entity_type: 'BUDGET', action: 'UPDATE', budget_resource_name: BUDGET, amount }, 'USD', deps);
}

function x(daily_budget: number) {
  const deps: XAdsWriteDeps = {
    ...common,
    consumedTokens: new Map(),
    request: jest.fn(async () => ({
      data: { id: 'c1', name: 'Launch', entity_status: 'PAUSED', funding_instrument_id: 'fi1', daily_budget_amount_local_micro: PRIOR },
    })) as any,
    listAll: jest.fn(async () => []),
  };
  const session = { accountId: 'acc1', credentials: { consumerKey: 'ck', consumerSecret: 'cs', token: 't', tokenSecret: 'ts' } };
  return executeXAdsWrite('u1', { entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_id: 'c1', daily_budget }, session as any, 'USD', deps);
}

const refusal = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return (e as Error).message; }
  throw new Error('expected a refusal');
};

describe.each([['Google', google], ['X', x]] as const)('ENG-3212 %s ceiling refusal in dollars', (_name, run) => {
  it('a 600/day budget is refused with currency amounts and no micros', async () => {
    const message = await refusal(run(600));
    expect(message).toContain("daily_budget 600.00 USD exceeds this account's max daily budget of 500.00 USD.");
    expect(message).not.toMatch(/micros|minor units|600000000|500000000/);
  });

  it('a more-than-2x change is refused with currency amounts and no micros', async () => {
    const message = await refusal(run(300));
    expect(message).toContain('daily_budget change 100.00 USD -> 300.00 USD is 3.00x');
    expect(message).not.toMatch(/micros|minor units|300000000|100000000/);
  });

  it('a 5/day budget is still allowed (a preview, not a refusal)', async () => {
    await expect(run(5)).resolves.toMatchObject({ status: 'PREVIEW' });
  });
});
