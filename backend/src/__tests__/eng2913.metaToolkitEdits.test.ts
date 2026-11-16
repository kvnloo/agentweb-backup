process.env.ZOMA_REQUIRE_PAYMENT_METHOD = 'true';
/**
 * ENG-2913 (reuses the ENG-2303 harness) — post-launch edits. Original ENG-2303 P3 acceptance (spec: /home/harsha/zoma-build/SPEC.md, "Guarded writes"):
 *  - a write without a preview is refused (nothing dispatched);
 *  - a write without a payment method is refused;
 *  - new entities are created PAUSED (ACTIVE on create refused);
 *  - ACTIVE needs its own preview + confirm (cannot ride a PAUSED/budget approval);
 *  - money is echoed in the ad account currency (TWD/JPY zero-decimal, USD cents);
 *  - granted ads_management (D4) is required; spend ceiling is enforced;
 *  - a write whose read-back cannot confirm it is UNCONFIRMED, never success.
 */
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../mcp/zomaOnboarding', () => {
  const actual = jest.requireActual('../mcp/zomaOnboarding');
  return { ...actual, assertZomaWriteReady: jest.fn() };
});

import { normalizeMetaMoney } from '../services/metaService';
import { targetingApplied } from '../mcp/metaToolkitWrites';
import { executeMetaToolkitWrite, spendCeilingPolicyFromEnv, type MetaToolkitWriteDeps } from '../mcp/metaToolkitWrites';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';
import { ZomaNotReadyError } from '../mcp/zomaOnboarding';

const NOW = 1_800_000_000_000;
const account = (scopes: unknown = ['ads_read', 'ads_management']) => ({  // 'none' = legacy row with no granted_scopes
  platform: 'meta',
  account_id: 'act_111',
  config: { account_type: 'ad_account', access_token: 'tok', ad_account_id: '111', ...(scopes === 'none' ? {} : { granted_scopes: scopes }) },
});

function makeDeps(over: Partial<MetaToolkitWriteDeps> = {}, currency = 'USD') {
  const MONEY = ['budget_amount', 'daily_budget', 'lifetime_budget', 'bid_amount', 'spend_cap'];
  const deps: MetaToolkitWriteDeps = {
    assertReady: jest.fn().mockResolvedValue(undefined),
    listAccounts: jest.fn().mockResolvedValue([account()]),
    // Real currency normalizer (the one the writers use), fixed account currency.
    previewMoney: jest.fn(async (_u: string, _a: string, params: any) => {
      const out = { ...params };
      const parts: string[] = [];
      for (const f of MONEY) {
        if (params[f] === undefined) continue;
        const m = normalizeMetaMoney(params[f], currency);
        const api = f === 'budget_amount' ? 'daily_budget' : f;
        out[api] = m.minorUnits;
        parts.push(`${api}: ${m.description}`);
      }
      delete out.budget_amount;
      return { params: out, currency, confirmation: ` (money submitted: ${parts.join('; ')})` };
    }),
    preview: jest.fn(async (_u: string, entity: string, action: string, accountId: string, c?: string, as?: string, ad?: string, params?: any) => ({
      success: true,
      awaitingUserConfirmation: true,
      summary: `${action} ${entity} on ${accountId}${c ? ` campaign ${c}` : ''}`,
      metaWriteManifestDigest: 'internal-digest',
      metaWriteDispatch: { entity_type: entity, action, account_id: accountId, resolvedAccountId: accountId, campaign_id: c, ad_set_id: as, ad_id: ad, params },
    })),
    dispatch: jest.fn().mockResolvedValue({ result: { success: true, message: 'Campaign "X" created successfully' }, createdId: '999' }),
    readBack: jest.fn().mockResolvedValue({ id: '999', status: 'PAUSED', effective_status: 'PAUSED', daily_budget: '5000' }),
    assertCreativeOwned: jest.fn().mockResolvedValue(undefined),
    spendCeilingPolicy: () => null,
    secret: () => 'test-secret',
    now: () => NOW,
    consumedTokens: new Map(),
    ...over,
  };
  return deps as MetaToolkitWriteDeps & Record<string, jest.Mock>;
}

const createArgs = (params: any = {}) => ({
  entity_type: 'CAMPAIGN', action: 'CREATE', account_id: '111',
  params: { name: 'Phoenix Leads', objective: 'OUTCOME_LEADS', daily_budget: 50, ...params },
});

async function previewThenConfirm(deps: MetaToolkitWriteDeps, args: any) {
  const preview: any = await executeMetaToolkitWrite('u1', args, deps);
  expect(preview.status).toBe('PREVIEW');
  return executeMetaToolkitWrite('u1', { ...args, confirm: true, preview_token: preview.preview_token }, deps);
}


const upd = (entity: string, params: any, id: Record<string, string>) => ({ entity_type: entity, action: 'UPDATE', account_id: '111', ...id, params });

describe('ENG-2913 post-launch edits', () => {
  it('AD_SET bid/targeting/schedule: preview shows a before → after diff, confirm dispatches and verifies every field', async () => {
    const targeting = { geo_locations: { countries: ['US'] }, age_min: 25, excluded_custom_audiences: [{ id: '777' }] };
    const prior = { id: '5', status: 'PAUSED', bid_strategy: 'LOWEST_COST_WITHOUT_CAP', targeting: { geo_locations: { countries: ['CA'] } }, end_time: undefined };
    const after = {
      id: '5', status: 'PAUSED', bid_strategy: 'COST_CAP', bid_amount: '1250', end_time: '2026-12-31T23:59:00-0800',
      targeting: { geo_locations: { countries: ['US'], location_types: ['home'] }, age_min: 25, excluded_custom_audiences: [{ id: '777', name: 'Subscribers' }] },
    };
    const readBack = jest.fn().mockResolvedValueOnce(prior).mockResolvedValueOnce(prior).mockResolvedValue(after);
    const deps = makeDeps({ readBack });
    const args = upd('AD_SET', { bid_strategy: 'COST_CAP', bid_amount: 12.5, targeting, end_time: '2026-12-31T23:59:00-0800' }, { ad_set_id: '5' });
    const preview: any = await executeMetaToolkitWrite('u1', args, deps);
    expect(preview.status).toBe('PREVIEW');
    expect(preview.preview).toContain('- bid_strategy: LOWEST_COST_WITHOUT_CAP → COST_CAP');
    expect(preview.preview).toContain('- bid_amount: (not set) → 1250');
    expect(preview.preview).toContain('"countries":["CA"]');
    expect(preview.preview).toContain('Targeting is replaced as a whole');
    expect(deps.dispatch).not.toHaveBeenCalled();
    const done: any = await executeMetaToolkitWrite('u1', { ...args, confirm: true, preview_token: preview.preview_token }, deps);
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect(done.verification).toBe('CONFIRMED');
  });

  it('a field Meta did not apply is MISMATCH, a field missing from read-back is UNCONFIRMED', async () => {
    const prior = { id: '5', status: 'PAUSED', bid_strategy: 'LOWEST_COST_WITHOUT_CAP' };
    const args = upd('AD_SET', { bid_strategy: 'COST_CAP', bid_amount: 10 }, { ad_set_id: '5' });
    let deps = makeDeps({ readBack: jest.fn().mockResolvedValueOnce(prior).mockResolvedValueOnce(prior).mockResolvedValue({ ...prior, bid_amount: '1000' }) });
    expect(((await previewThenConfirm(deps, args)) as any).verification).toBe('MISMATCH');
    deps = makeDeps({ readBack: jest.fn().mockResolvedValueOnce(prior).mockResolvedValueOnce(prior).mockResolvedValue({ id: '5', status: 'PAUSED', bid_strategy: 'COST_CAP' }) });
    expect(((await previewThenConfirm(deps, args)) as any).verification).toBe('UNCONFIRMED');
  });

  it('AD creative swap verifies the live creative id; a rename verifies the name', async () => {
    const prior = { id: '9', status: 'ACTIVE', name: 'Old', creative_id: '100' };
    const swap = upd('AD', { creative_id: '200' }, { ad_id: '9' });
    const preview: any = await executeMetaToolkitWrite('u1', swap, makeDeps({ readBack: jest.fn().mockResolvedValue(prior) }));
    expect(preview.preview).toContain('- creative_id: 100 → 200');
    let deps = makeDeps({ readBack: jest.fn().mockResolvedValueOnce(prior).mockResolvedValueOnce(prior).mockResolvedValue({ ...prior, creative_id: '200' }) });
    expect(((await previewThenConfirm(deps, swap)) as any).verification).toBe('CONFIRMED');
    expect(deps.assertCreativeOwned).toHaveBeenCalledWith('u1', '111', '200');
    deps = makeDeps({ readBack: jest.fn().mockResolvedValueOnce(prior).mockResolvedValueOnce(prior).mockResolvedValue(prior) });
    expect(((await previewThenConfirm(deps, swap)) as any).verification).toBe('MISMATCH');
    const rename = upd('AD', { name: 'New' }, { ad_id: '9' });
    deps = makeDeps({ readBack: jest.fn().mockResolvedValueOnce(prior).mockResolvedValueOnce(prior).mockResolvedValue({ ...prior, name: 'New' }) });
    expect(((await previewThenConfirm(deps, rename)) as any).verification).toBe('CONFIRMED');
  });

  it('refuses a creative swap combined with other ad edits (two Meta updates could leave it half-changed)', async () => {
    const deps = makeDeps();
    await expect(executeMetaToolkitWrite('u1', upd('AD', { creative_id: '200', name: 'New' }, { ad_id: '9' }), deps)).rejects.toThrow(/its own UPDATE/);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('refuses a creative from another ad account before issuing a preview token', async () => {
    const deps = makeDeps({ assertCreativeOwned: jest.fn().mockRejectedValue(new Error('owned by act_999')) });
    await expect(executeMetaToolkitWrite('u1', upd('AD', { creative_id: '200' }, { ad_id: '9' }), deps)).rejects.toThrow(/not found in ad account 111/);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['AD_SET', { daily_budget: 50, targeting: { geo_locations: { countries: ['US'] } } }, { ad_set_id: '5' }],
    ['CAMPAIGN', { spend_cap: 500, bid_strategy: 'COST_CAP' }, { campaign_id: '1' }],
  ])('refuses a %s budget change bundled with other edits (the rate shaper could drop them as "no change")', async (entity, params, ids) => {
    const deps = makeDeps();
    await expect(executeMetaToolkitWrite('u1', upd(entity, params, ids), deps)).rejects.toThrow(/budget or spend cap in its own UPDATE/);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('a schedule change on an ACTIVE ad set is its own change, warned, and held to the enable spend ceiling', async () => {
    const prior = { id: '5', status: 'ACTIVE', daily_budget: '90000', end_time: '2026-01-01T00:00:00+0000' };
    let deps = makeDeps({ readBack: jest.fn().mockResolvedValue(prior) });
    await expect(executeMetaToolkitWrite('u1', upd('AD_SET', { end_time: '2027-01-01T00:00:00Z', bid_strategy: 'COST_CAP' }, { ad_set_id: '5' }), deps))
      .rejects.toThrow(/schedule in its own UPDATE/);
    const preview: any = await executeMetaToolkitWrite('u1', upd('AD_SET', { end_time: '2027-01-01T00:00:00Z' }, { ad_set_id: '5' }), deps);
    expect(preview.preview).toMatch(/ACTIVE: the new schedule can start or extend delivery/);
    deps = makeDeps({ readBack: jest.fn().mockResolvedValue(prior), spendCeilingPolicy: () => ({ maxDailyBudget: 10000 }) });
    await expect(executeMetaToolkitWrite('u1', upd('AD_SET', { end_time: '2027-01-01T00:00:00Z' }, { ad_set_id: '5' }), deps)).rejects.toThrow(/schedule of this ACTIVE ad set/);
    deps = makeDeps({ readBack: jest.fn().mockResolvedValue(null) });
    await expect(executeMetaToolkitWrite('u1', upd('AD_SET', { end_time: '2027-01-01T00:00:00Z' }, { ad_set_id: '5' }), deps)).rejects.toThrow(/current status/);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('CAMPAIGN bid_strategy and spend_cap are allowed as separate UPDATEs; spend_cap verified in minor units', async () => {
    // spend_cap is coalesced by the write rate shaper like a budget, so it is its own UPDATE
    // (a bundled bid_strategy could otherwise be dropped as "no change").
    const prior = { id: '1', status: 'PAUSED', bid_strategy: 'LOWEST_COST_WITHOUT_CAP' };
    let deps = makeDeps({
      readBack: jest.fn().mockResolvedValueOnce(prior).mockResolvedValueOnce(prior).mockResolvedValue({ ...prior, bid_strategy: 'COST_CAP' }),
    });
    expect(((await previewThenConfirm(deps, upd('CAMPAIGN', { bid_strategy: 'COST_CAP' }, { campaign_id: '1' }))) as any).verification).toBe('CONFIRMED');
    deps = makeDeps({
      previewMoney: jest.fn(async (_u: string, _a: string, p: any) => ({ params: { ...p, spend_cap: 50000 }, confirmation: ' (money submitted: spend_cap: $500.00)' })),
      readBack: jest.fn().mockResolvedValueOnce(prior).mockResolvedValueOnce(prior).mockResolvedValue({ ...prior, spend_cap: '50000' }),
    });
    expect(((await previewThenConfirm(deps, upd('CAMPAIGN', { spend_cap: 500 }, { campaign_id: '1' }))) as any).verification).toBe('CONFIRMED');
  });

  it.each([
    ['unknown field', upd('AD', { body: 'new copy' }, { ad_id: '9' }), /can change only/],
    ['bad bid_strategy', upd('AD_SET', { bid_strategy: 'CHEAPEST' }, { ad_set_id: '5' }), /bid_strategy must be one of/],
    ['bid_amount with no-cap', upd('AD_SET', { bid_strategy: 'LOWEST_COST_WITHOUT_CAP', bid_amount: 3 }, { ad_set_id: '5' }), /must not be set/],
    ['targeting not an object', upd('AD_SET', { targeting: 'US' }, { ad_set_id: '5' }), /targeting must be/],
    ['bad exclusion', upd('AD_SET', { targeting: { excluded_custom_audiences: ['777'] } }, { ad_set_id: '5' }), /excluded_custom_audiences/],
    ['bad time', upd('AD_SET', { end_time: 'next friday' }, { ad_set_id: '5' }), /ISO 8601/],
    ['ROAS bidding (no ROAS floor field; unsupported on create)', upd('AD_SET', { bid_strategy: 'LOWEST_COST_WITH_MIN_ROAS' }, { ad_set_id: '5' }), /bid_strategy must be one of/],
    ['an impossible calendar date', upd('AD_SET', { end_time: '2026-02-30T09:00:00-0800' }, { ad_set_id: '5' }), /ISO 8601/],
    ['a PAUSE bundled with a budget (a coalesced budget repeat would drop the pause)', upd('AD_SET', { status: 'PAUSED', daily_budget: 50 }, { ad_set_id: '5' }), /budget or spend cap in its own UPDATE/],
    ['targeting without locations (it would strip the ad set\'s countries)', upd('AD_SET', { targeting: { excluded_custom_audiences: [{ id: '777' }] } }, { ad_set_id: '5' }), /geo_locations is required/],
    ['targeting with an empty location list', upd('AD_SET', { targeting: { geo_locations: { countries: [] } } }, { ad_set_id: '5' }), /geo_locations is required/],
    ['a bid above the create-path safety limit', upd('AD_SET', { bid_strategy: 'COST_CAP', bid_amount: 5000 }, { ad_set_id: '5' }), /safety limit/],
    ['time without a timezone offset', upd('AD_SET', { end_time: '2026-12-01T09:00' }, { ad_set_id: '5' }), /offset/],
    ['bare number as a time', upd('AD_SET', { end_time: '1' }, { ad_set_id: '5' }), /ISO 8601/],
    ['end before start', upd('AD_SET', { start_time: '2026-12-02T00:00:00Z', end_time: '2026-12-01T00:00:00Z' }, { ad_set_id: '5' }), /after start_time/],
    ['bad creative id', upd('AD', { creative_id: 'abc' }, { ad_id: '9' }), /creative_id must be/],
    ['activation bundled with an edit', upd('AD_SET', { status: 'ACTIVE', bid_amount: 5 }, { ad_set_id: '5' }), /its own change/],
  ])('refuses %s with nothing dispatched', async (_n, args, msg) => {
    const deps = makeDeps();
    await expect(executeMetaToolkitWrite('u1', args, deps)).rejects.toThrow(msg as RegExp);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('a Meta-state change between preview and confirm invalidates the token (diff is bound)', async () => {
    const readBack = jest.fn()
      .mockResolvedValueOnce({ id: '5', status: 'PAUSED', bid_strategy: 'LOWEST_COST_WITHOUT_CAP' })
      .mockResolvedValue({ id: '5', status: 'PAUSED', bid_strategy: 'LOWEST_COST_WITH_BID_CAP' });
    const deps = makeDeps({ readBack });
    const args = upd('AD_SET', { bid_strategy: 'COST_CAP', bid_amount: 5 }, { ad_set_id: '5' });
    const preview: any = await executeMetaToolkitWrite('u1', args, deps);
    const r: any = await executeMetaToolkitWrite('u1', { ...args, confirm: true, preview_token: preview.preview_token }, deps);
    expect(r.status).toBe('PREVIEW_MISMATCH');
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('a failed Meta lookup of the creative is reported as a Meta problem, not "not found in ad account"', async () => {
    const deps = makeDeps({ assertCreativeOwned: jest.fn().mockRejectedValue(Object.assign(new Error('Service temporarily unavailable'), { creativeLookupFailed: true })) });
    await expect(executeMetaToolkitWrite('u1', upd('AD', { creative_id: '200' }, { ad_id: '9' }), deps)).rejects.toThrow(/Could not check creative 200 with Meta right now/);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('a bid_amount alone on a LOWEST_COST_WITHOUT_CAP ad set is refused (Meta would store it unused)', async () => {
    const deps = makeDeps({ readBack: jest.fn().mockResolvedValue({ id: '5', status: 'ACTIVE', bid_strategy: 'LOWEST_COST_WITHOUT_CAP' }) });
    await expect(executeMetaToolkitWrite('u1', upd('AD_SET', { bid_amount: 10 }, { ad_set_id: '5' }), deps)).rejects.toThrow(/ignores bid_amount/);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['targeting', { targeting: { geo_locations: { countries: ['CA'] } } }],
    ['status', { status: 'ACTIVE' }],
  ])('an approval does not apply after someone else changed the ad set\'s %s', async (_n, change) => {
    const before = { id: '5', status: 'PAUSED', bid_strategy: 'COST_CAP', bid_amount: '300', targeting: { geo_locations: { countries: ['US'] } } };
    const readBack = jest.fn().mockResolvedValueOnce(before).mockResolvedValue({ ...before, ...change });
    const deps = makeDeps({ readBack });
    const args = upd('AD_SET', { bid_amount: 5 }, { ad_set_id: '5' });
    const preview: any = await executeMetaToolkitWrite('u1', args, deps);
    const r: any = await executeMetaToolkitWrite('u1', { ...args, confirm: true, preview_token: preview.preview_token }, deps);
    expect(r.status).toBe('PREVIEW_MISMATCH');
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('an unparseable read-back time is UNCONFIRMED, not MISMATCH', async () => {
    const prior = { id: '5', status: 'PAUSED', end_time: '2026-11-01T00:00:00+0000' };
    const deps = makeDeps({ readBack: jest.fn().mockResolvedValueOnce(prior).mockResolvedValueOnce(prior).mockResolvedValue({ ...prior, end_time: 'not-a-date' }) });
    expect(((await previewThenConfirm(deps, upd('AD_SET', { end_time: '2027-01-01T00:00:00Z' }, { ad_set_id: '5' }))) as any).verification).toBe('UNCONFIRMED');
  });

  it('a schedule preview made while PAUSED does not confirm after the ad set went ACTIVE (no spend policy)', async () => {
    const readBack = jest.fn()
      .mockResolvedValueOnce({ id: '5', status: 'PAUSED' })
      .mockResolvedValue({ id: '5', status: 'ACTIVE' });
    const deps = makeDeps({ readBack });
    const args = upd('AD_SET', { end_time: '2027-01-01T00:00:00Z' }, { ad_set_id: '5' });
    const preview: any = await executeMetaToolkitWrite('u1', args, deps);
    expect(preview.preview).not.toMatch(/ACTIVE: the new schedule/);
    const r: any = await executeMetaToolkitWrite('u1', { ...args, confirm: true, preview_token: preview.preview_token }, deps);
    expect(r.status).toBe('PREVIEW_MISMATCH');
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('targeting read-back: lists must match exactly; a dropped exclusion list must be gone (no false CONFIRMED)', () => {
    // Meta kept an extra country / an extra exclusion: not what was approved.
    expect(targetingApplied({ geo_locations: { countries: ['US'] } }, { geo_locations: { countries: ['US', 'CA'] } })).toBe(false);
    expect(targetingApplied({ excluded_custom_audiences: [{ id: '1' }] }, { excluded_custom_audiences: [{ id: '1' }, { id: '2' }] })).toBe(false);
    // "No exclusions": [] matches absent/empty, not a populated list.
    expect(targetingApplied({ excluded_custom_audiences: [] }, {})).toBe(true);
    expect(targetingApplied({ excluded_custom_audiences: [] }, { excluded_custom_audiences: [{ id: '1' }] })).toBe(false);
  });

  it('a full targeting replacement that leaves out exclusions is MISMATCH while Meta still reports them', async () => {
    const prior = { id: '5', status: 'PAUSED', targeting: { geo_locations: { countries: ['US'] }, excluded_custom_audiences: [{ id: '7' }] } };
    const args = upd('AD_SET', { targeting: { geo_locations: { countries: ['US'] } } }, { ad_set_id: '5' });
    let deps = makeDeps({ readBack: jest.fn().mockResolvedValue(prior) });
    expect(((await previewThenConfirm(deps, args)) as any).verification).toBe('MISMATCH');
    deps = makeDeps({ readBack: jest.fn().mockResolvedValueOnce(prior).mockResolvedValueOnce(prior).mockResolvedValue({ ...prior, targeting: { geo_locations: { countries: ['US'] } } }) });
    expect(((await previewThenConfirm(deps, args)) as any).verification).toBe('CONFIRMED');
  });

  it('targetingApplied is containment, matching object lists by id', () => {
    expect(targetingApplied({ excluded_custom_audiences: [{ id: '1' }], age_min: 25 }, { excluded_custom_audiences: [{ id: '1', name: 'x' }], age_min: 25, age_max: 65 })).toBe(true);
    expect(targetingApplied({ excluded_custom_audiences: [{ id: '1' }] }, { excluded_custom_audiences: [{ id: '2' }] })).toBe(false);
    expect(targetingApplied({ geo_locations: { countries: ['US'] } }, { geo_locations: { countries: ['CA'] } })).toBe(false);
  });
});
