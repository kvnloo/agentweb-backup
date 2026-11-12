process.env.ZOMA_REQUIRE_PAYMENT_METHOD = 'true';
/**
 * ENG-2960 name-only edits on CAMPAIGN / AD_SET (reuses the ENG-2913 harness). Original ENG-2913 header:
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

import { handleMetaToolkitCall, type MetaToolkitGatewayDeps } from '../mcp/metaToolkitGateway';
import { getMetaToolkitManifest } from '../mcp/metaToolkitManifest';

describe('ENG-2960 CAMPAIGN / AD_SET / AD rename', () => {
  it.each([
    ['CAMPAIGN', { campaign_id: '1' }],
    ['AD_SET', { ad_set_id: '5' }],
    ['AD', { ad_id: '9' }],
  ])('%s name-only: preview shows old → new, status unchanged; confirm dispatches once and read-back CONFIRMS', async (entity, id) => {
    const prior = { id: Object.values(id)[0], status: 'ACTIVE', name: 'Old' };
    const readBack = jest.fn().mockResolvedValueOnce(prior).mockResolvedValueOnce(prior).mockResolvedValue({ ...prior, name: 'New' });
    const deps = makeDeps({ readBack });
    const args = upd(entity, { name: 'New' }, id);
    const preview: any = await executeMetaToolkitWrite('u1', args, deps);
    expect(preview.status).toBe('PREVIEW');
    expect(preview.preview).toContain('- name: Old → New');
    expect(preview.preview).toContain('Status: unchanged.');
    expect(deps.dispatch).not.toHaveBeenCalled();
    const done: any = await executeMetaToolkitWrite('u1', { ...args, confirm: true, preview_token: preview.preview_token }, deps);
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect((deps.dispatch as jest.Mock).mock.calls[0][1].params).toEqual({ name: 'New' });
    expect(done.verification).toBe('CONFIRMED');
  });

  it('a name Meta did not apply is MISMATCH, never success', async () => {
    const prior = { id: '1', status: 'PAUSED', name: 'Old' };
    const deps = makeDeps({ readBack: jest.fn().mockResolvedValue(prior) });
    const done: any = await previewThenConfirm(deps, upd('CAMPAIGN', { name: 'New' }, { campaign_id: '1' }));
    expect(done.verification).toBe('MISMATCH');
  });

  it('a token for one name cannot confirm a different name', async () => {
    const deps = makeDeps({ readBack: jest.fn().mockResolvedValue({ id: '5', status: 'PAUSED', name: 'Old' }) });
    const preview: any = await executeMetaToolkitWrite('u1', upd('AD_SET', { name: 'A' }, { ad_set_id: '5' }), deps);
    const res: any = await executeMetaToolkitWrite('u1', { ...upd('AD_SET', { name: 'B' }, { ad_set_id: '5' }), confirm: true, preview_token: preview.preview_token }, deps);
    expect(res.status).toBe('PREVIEW_MISMATCH');
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['CAMPAIGN', { name: 'x', objective: 'OUTCOME_SALES' }, { campaign_id: '1' }, /can change only.*Not allowed: objective/],
    ['AD_SET', { name: 'x', promoted_object: { pixel_id: '1' } }, { ad_set_id: '5' }, /can change only.*Not allowed: promoted_object/],
    ['AD_SET', { name: 'x', status: 'ACTIVE' }, { ad_set_id: '5' }, /Activation \(status=ACTIVE\) must be its own change/],
    ['CAMPAIGN', { name: 'x', daily_budget: 50 }, { campaign_id: '1' }, /budget or spend cap in its own UPDATE/],
    ['AD', { name: 'x', creative_id: '200' }, { ad_id: '9' }, /its own UPDATE/],
    ['CAMPAIGN', { name: '  ' }, { campaign_id: '1' }, /name must be a non-empty string/],
  ])('%s %j is refused with a caller-visible error, nothing sent', async (entity, params, id, msg) => {
    const deps = makeDeps();
    await expect(executeMetaToolkitWrite('u1', upd(entity, params, id), deps)).rejects.toThrow(msg);
    expect(deps.preview).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('a foreign campaign (shared gate refuses ownership) is a refusal, nothing dispatched', async () => {
    const deps = makeDeps({
      readBack: jest.fn().mockResolvedValue(null),
      preview: jest.fn().mockResolvedValue({ success: false, error: 'Campaign 77 does not belong to ad account act_111' }),
    });
    await expect(executeMetaToolkitWrite('u1', upd('CAMPAIGN', { name: 'x' }, { campaign_id: '77' }), deps)).rejects.toThrow(/Not prepared, nothing was sent to Meta: Campaign 77 does not belong/);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('a read-only aw_ key cannot rename', async () => {
    const deps = {
      validateApiKey: jest.fn().mockResolvedValue({ userId: 'u1', keyId: 'k1', scopes: ['tools:read'] }),
      validateOAuthToken: jest.fn().mockResolvedValue(null),
      listAccounts: jest.fn(),
      execute: jest.fn(),
      recordUsage: jest.fn().mockResolvedValue(true),
      recordWrite: jest.fn().mockResolvedValue(true),
      now: () => NOW,
      rateLimiter: { check: () => ({ allowed: true, remaining: 1, resetInMs: 0 }) },
    } as unknown as MetaToolkitGatewayDeps & Record<string, jest.Mock>;
    await expect(handleMetaToolkitCall({ authorization: 'Bearer aw_x', toolName: 'call_meta_marketing_api', args: upd('CAMPAIGN', { name: 'x' }, { campaign_id: '1' }) }, deps))
      .rejects.toMatchObject({ status: 403 });
    expect(deps.listAccounts).not.toHaveBeenCalled();
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('the advertised description documents name edits on all three entities', () => {
    const tool = getMetaToolkitManifest().find((t: any) => t.name === 'call_meta_marketing_api') as any;
    expect(tool.description).toContain('name (CAMPAIGN, AD_SET, AD)');
  });
});
