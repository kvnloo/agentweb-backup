/**
 * ENG-2823 hardening — adversarial cases for the Zoma Google Ads guarded writes.
 *  - Ambiguous dispatch failures (timeout / network / 5xx / throw) are UNCONFIRMED, never
 *    "did not apply": that wording invites a retry that double-applies a CREATE.
 *  - Money inputs: huge, zero, negative, string, NaN, extra precision are refused before
 *    anything is read or sent.
 *  - Enabling a campaign is held to the spend ceiling at its budget (fail closed).
 *  - Creates are always PAUSED; tokens are bound to the customer as well as the user.
 */
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));

import { executeGoogleToolkitWrite, googleSpendCeilingPolicyFromEnv, majorToMicros, type GoogleToolkitWriteDeps } from '../mcp/googleToolkitWrites';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';

const NOW = Date.parse('2026-11-05T00:00:00Z');
const CID = '1234567890';
const BUDGET = `customers/${CID}/campaignBudgets/55`;
const CAMPAIGN = `customers/${CID}/campaigns/77`;

function deps(over: Partial<GoogleToolkitWriteDeps> = {}) {
  const state: Record<string, any> = {
    [BUDGET]: { resourceName: BUDGET, name: 'Daily', amountMicros: 200_000_000, explicitlyShared: false, referenceCount: 1 },
    [CAMPAIGN]: { resourceName: CAMPAIGN, name: 'Brand', status: 'PAUSED', budget: BUDGET },
  };
  const d: GoogleToolkitWriteDeps & { state: Record<string, any> } = {
    state,
    assertReady: jest.fn().mockResolvedValue(undefined),
    read: jest.fn(async (_u: string, _c: string, _k: string, rn: string) => (state[rn] ? { ...state[rn] } : null)),
    dispatch: jest.fn().mockResolvedValue({ success: true }),
    spendCeilingPolicy: () => null,
    secret: () => 'test-secret',
    now: () => NOW,
    consumedTokens: new Map(),
    ...over,
  };
  return d;
}

async function previewThenConfirm(d: GoogleToolkitWriteDeps, args: any, user = 'u1') {
  const p: any = await executeGoogleToolkitWrite(user, args, 'USD', d);
  expect(p.status).toBe('PREVIEW');
  return executeGoogleToolkitWrite(user, { ...args, confirm: true, preview_token: p.preview_token }, 'USD', d) as Promise<any>;
}

const budgetCreate = { customer_id: CID, entity_type: 'BUDGET', action: 'CREATE', name: 'New', amount: 25 };
const budgetUpdate = { customer_id: CID, entity_type: 'BUDGET', action: 'UPDATE', budget_resource_name: BUDGET, amount: 50 };
const enable = { customer_id: CID, entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_resource_name: CAMPAIGN, status: 'ENABLED' };

describe('ENG-2823 hardening: ambiguous dispatch failures are never reported as "not applied"', () => {
  it.each([
    ['a timeout (no HTTP status)', { success: false, error: 'timeout of 30000ms exceeded' }],
    ['a network error', { success: false, error: 'socket hang up' }],
    ['a Google 5xx', { success: false, error: 'DEADLINE_EXCEEDED', code: 504 }],
  ])('%s on a confirmed CREATE is UNCONFIRMED with a check-before-retry instruction', async (_label, failure) => {
    const d = deps({ dispatch: jest.fn().mockResolvedValue(failure) });
    const r = await previewThenConfirm(d, budgetCreate);
    expect(d.dispatch).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ success: false, verification: 'UNCONFIRMED' });
    expect(r.message).toMatch(/may or may not have been applied/);
    expect(r.message).toMatch(/Do not retry blindly/);
    expect(r.message).not.toMatch(/did not apply/);
  });

  it('a throwing dispatch after the token was consumed is UNCONFIRMED, not an opaque 500', async () => {
    const d = deps({ dispatch: jest.fn().mockRejectedValue(new Error('ECONNRESET')) });
    const r = await previewThenConfirm(d, budgetCreate);
    expect(r).toMatchObject({ success: false, verification: 'UNCONFIRMED' });
  });

  it('an ambiguous UPDATE failure reads the target back so the caller sees the current state', async () => {
    const d = deps({ dispatch: jest.fn().mockResolvedValue({ success: false, error: 'timeout' }) });
    const r = await previewThenConfirm(d, budgetUpdate);
    expect(r).toMatchObject({ verification: 'UNCONFIRMED', id: BUDGET, amount_micros: 200_000_000 });
  });

  it.each([[undefined], [{}], [{ message: 'ok?' }]])('a dispatch result with no success verdict (%p) is UNCONFIRMED, not FAILED', async (shape) => {
    const d = deps({ dispatch: jest.fn().mockResolvedValue(shape) });
    const r = await previewThenConfirm(d, budgetCreate);
    expect(r).toMatchObject({ success: false, verification: 'UNCONFIRMED' });
  });

  it('a definite Google rejection (4xx) is still FAILED with no verification (nothing applied)', async () => {
    const d = deps({ dispatch: jest.fn().mockResolvedValue({ success: false, error: 'RANGE_ERROR: too low', code: 400 }) });
    const r = await previewThenConfirm(d, budgetCreate);
    expect(r).toMatchObject({ status: 'FAILED', success: false });
    expect(r.verification).toBeUndefined();
  });

  it('an auth failure is FAILED (credentials failed before any mutate)', async () => {
    const d = deps({ dispatch: jest.fn().mockResolvedValue({ success: false, error: 'reconnect', authError: true }) });
    const r = await previewThenConfirm(d, budgetCreate);
    expect(r.status).toBe('FAILED');
  });
});

describe('ENG-2823 hardening: money inputs', () => {
  it.each([
    ['a huge amount (micros not a safe integer)', 1e15],
    ['zero', 0],
    ['a negative amount', -5],
    ['a numeric string', '50'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['null', null],
  ])('BUDGET UPDATE with %s is refused before anything is read or sent', async (_label, amount) => {
    const d = deps();
    await expect(executeGoogleToolkitWrite('u1', { ...budgetUpdate, amount }, 'USD', d)).rejects.toBeInstanceOf(MetaToolkitRefusal);
    expect(d.assertReady).not.toHaveBeenCalled();
    expect(d.read).not.toHaveBeenCalled();
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('a zero CPC bid / bid ceiling is refused (Google would reject; never a silent 0)', async () => {
    const d = deps();
    await expect(executeGoogleToolkitWrite('u1', {
      customer_id: CID, entity_type: 'AD_GROUP', action: 'CREATE', name: 'g', campaign_resource_name: CAMPAIGN, type: 'SEARCH_STANDARD', cpc_bid: 0,
    }, 'USD', d)).rejects.toThrow(/cpc_bid must be greater than 0/);
    await expect(executeGoogleToolkitWrite('u1', {
      customer_id: CID, entity_type: 'CAMPAIGN', action: 'CREATE', name: 'c', type: 'SEARCH', budget_resource_name: BUDGET, bidding_strategy: 'TARGET_SPEND', cpc_bid_ceiling: 0,
    }, 'USD', d)).rejects.toThrow(/cpc_bid_ceiling must be greater than 0/);
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('currency precision: JPY has no decimals, KWD has three; floats like 19.99 convert exactly', () => {
    expect(() => majorToMicros(0.5, 'JPY', 'amount')).toThrow(/more decimals/);
    expect(majorToMicros(1.234, 'KWD', 'amount')).toBe(1_234_000);
    expect(majorToMicros(19.99, 'USD', 'amount')).toBe(19_990_000);
    expect(majorToMicros(0.01, 'USD', 'amount')).toBe(10_000);
  });
});

describe('ENG-2823 hardening: spend ceiling on enable', () => {
  const ceiling = (raw: string) => () => googleSpendCeilingPolicyFromEnv(raw);

  it.each(['[]', '[1]', '"100"', 'null', '7', '{}', '{"maxDailyBudgett":1}'])('a malformed ceiling (%s) refuses budget writes and enabling (fail closed)', async (raw) => {
    const d = deps({ spendCeilingPolicy: ceiling(raw) });
    await expect(executeGoogleToolkitWrite('u1', budgetUpdate, 'USD', d)).rejects.toThrow(/could not be evaluated/);
    await expect(executeGoogleToolkitWrite('u1', enable, 'USD', d)).rejects.toThrow(/could not be evaluated/);
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('enabling a campaign whose budget is above maxDailyBudget is refused, nothing sent', async () => {
    const d = deps({ spendCeilingPolicy: ceiling('{"maxDailyBudget":100000000}') }); // budget is 200 USD/day
    await expect(executeGoogleToolkitWrite('u1', enable, 'USD', d)).rejects.toThrow(/Enabling this campaign would start spend at its budget.*daily_budget 200\.00 USD exceeds this account.s max daily budget of 100\.00 USD\./);
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('enabling under the ceiling previews the budget it will spend at', async () => {
    const d = deps({ spendCeilingPolicy: ceiling('{"maxDailyBudget":300000000}') });
    const p: any = await executeGoogleToolkitWrite('u1', enable, 'USD', d);
    expect(p.status).toBe('PREVIEW');
    expect(p.preview).toContain('Budget "Daily": 200.00 USD/day (= 200000000 micros).');
  });

  it('fails closed when a ceiling is set but the campaign budget cannot be read', async () => {
    const d = deps({ spendCeilingPolicy: ceiling('{"maxDailyBudget":300000000}') });
    delete d.state[BUDGET];
    await expect(executeGoogleToolkitWrite('u1', enable, 'USD', d)).rejects.toThrow(/could not be evaluated/);
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('the approval is bound to the budget too: a budget raised after preview invalidates the token', async () => {
    const d = deps();
    const p: any = await executeGoogleToolkitWrite('u1', enable, 'USD', d);
    d.state[BUDGET].amountMicros = 900_000_000;
    const r: any = await executeGoogleToolkitWrite('u1', { ...enable, confirm: true, preview_token: p.preview_token }, 'USD', d);
    expect(r.status).toBe('PREVIEW_MISMATCH');
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('pausing does not need the budget and is never ceiling-blocked', async () => {
    const d = deps({ spendCeilingPolicy: ceiling('{"maxDailyBudget":1}') });
    d.state[CAMPAIGN].status = 'ENABLED';
    const p: any = await executeGoogleToolkitWrite('u1', { ...enable, status: 'PAUSED' }, 'USD', d);
    expect(p.status).toBe('PREVIEW');
  });
});

describe('ENG-2823 hardening: creates and token binding', () => {
  it.each(['ENABLED', 'enabled', 'REMOVED', ''])('CAMPAIGN / AD_GROUP CREATE with status %p is refused', async (status) => {
    const d = deps();
    d.state[BUDGET].explicitlyShared = true;
    await expect(executeGoogleToolkitWrite('u1', {
      customer_id: CID, entity_type: 'CAMPAIGN', action: 'CREATE', name: 'c', type: 'SEARCH', budget_resource_name: BUDGET, bidding_strategy: 'TARGET_SPEND', status,
    }, 'USD', d)).rejects.toThrow(/always created PAUSED/);
    await expect(executeGoogleToolkitWrite('u1', {
      customer_id: CID, entity_type: 'AD_GROUP', action: 'CREATE', name: 'g', campaign_resource_name: CAMPAIGN, type: 'SEARCH_STANDARD', status,
    }, 'USD', d)).rejects.toThrow(/always created PAUSED/);
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('an AD_GROUP CREATE with no status is dispatched as PAUSED', async () => {
    const d = deps({ dispatch: jest.fn().mockResolvedValue({ success: true, adGroupResourceName: `customers/${CID}/adGroups/1` }) });
    await previewThenConfirm(d, { customer_id: CID, entity_type: 'AD_GROUP', action: 'CREATE', name: 'g', campaign_resource_name: CAMPAIGN, type: 'SEARCH_STANDARD' });
    expect((d.dispatch as jest.Mock).mock.calls[0][1]).toMatchObject({ status: 'PAUSED' });
  });

  it('a token minted for one customer cannot confirm the same change on another customer', async () => {
    const OTHER = '5555555555';
    const d = deps({ read: jest.fn(async (_u: string, c: string, _k: string, rn: string) => ({ resourceName: rn, name: 'Daily', amountMicros: 200_000_000, explicitlyShared: false, referenceCount: 1 })) });
    const p: any = await executeGoogleToolkitWrite('u1', budgetUpdate, 'USD', d);
    const r: any = await executeGoogleToolkitWrite('u1', {
      ...budgetUpdate, customer_id: OTHER, budget_resource_name: `customers/${OTHER}/campaignBudgets/55`, confirm: true, preview_token: p.preview_token,
    }, 'USD', d);
    expect(r.status).toBe('PREVIEW_MISMATCH');
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('a forged/tampered token (extended expiry) is rejected', async () => {
    const d = deps();
    const p: any = await executeGoogleToolkitWrite('u1', budgetUpdate, 'USD', d);
    const [v, , mac] = p.preview_token.split('.');
    const forged = `${v}.${NOW + 10 * 365 * 86400_000}.${mac}`;
    const r: any = await executeGoogleToolkitWrite('u1', { ...budgetUpdate, confirm: true, preview_token: forged }, 'USD', d);
    expect(r.status).toBe('PREVIEW_MISMATCH');
    expect(d.dispatch).not.toHaveBeenCalled();
  });
});
