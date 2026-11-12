process.env.ZOMA_REQUIRE_PAYMENT_METHOD = 'true';
/**
 * ENG-2303 P3 acceptance (spec: /home/harsha/zoma-build/SPEC.md, "Guarded writes"):
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
  const MONEY = ['budget_amount', 'daily_budget', 'lifetime_budget'];
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

describe('ENG-2303 guarded Meta writes', () => {
  it('a write without a preview (confirm=true, no token) is refused and nothing is dispatched', async () => {
    const deps = makeDeps();
    const res: any = await executeMetaToolkitWrite('u1', { ...createArgs(), confirm: true }, deps);
    expect(res.status).toBe('PREVIEW_MISMATCH');
    expect(res.success).toBe(false);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('the preview changes nothing and hides internal correlators', async () => {
    const deps = makeDeps();
    const res: any = await executeMetaToolkitWrite('u1', createArgs(), deps);
    expect(res.status).toBe('PREVIEW');
    expect(res.preview).toContain('PREVIEW — nothing has changed yet.');
    expect(res.preview).toContain('Objective: OUTCOME_LEADS');
    expect(JSON.stringify(res)).not.toMatch(/internal-digest|metaWriteDispatch/);
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.preview).toHaveBeenCalledTimes(1);
  });

  it('a write without a payment method is refused before any preview', async () => {
    const deps = makeDeps({ assertReady: jest.fn().mockRejectedValue(new ZomaNotReadyError('No payment method on file, so no change was made.')) });
    await expect(executeMetaToolkitWrite('u1', createArgs(), deps)).rejects.toThrow(/No payment method on file/);
    await expect(executeMetaToolkitWrite('u1', createArgs(), deps)).rejects.toBeInstanceOf(MetaToolkitRefusal);
    expect(deps.preview).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('CREATE is forced PAUSED, confirmed by read-back with id + effective_status', async () => {
    const deps = makeDeps();
    const res: any = await previewThenConfirm(deps, createArgs());
    expect((deps.preview as jest.Mock).mock.calls[0][7].status).toBe('PAUSED');
    expect((deps.dispatch as jest.Mock).mock.calls[0][1].params.status).toBe('PAUSED');
    expect(res).toMatchObject({ success: true, verification: 'CONFIRMED', id: '999', status: 'PAUSED', effective_status: 'PAUSED' });
  });

  it('CREATE with status ACTIVE is refused (activation is separate)', async () => {
    const deps = makeDeps();
    await expect(executeMetaToolkitWrite('u1', createArgs({ status: 'ACTIVE' }), deps)).rejects.toThrow(/always created PAUSED/);
    expect(deps.preview).not.toHaveBeenCalled();
  });

  it('ACTIVE cannot ride another approval: combined with a budget it is refused; a PAUSED token does not confirm ACTIVE', async () => {
    const deps = makeDeps();
    const upd = (params: any) => ({ entity_type: 'CAMPAIGN', action: 'UPDATE', account_id: '111', campaign_id: '999', params });
    await expect(executeMetaToolkitWrite('u1', upd({ status: 'ACTIVE', daily_budget: 80 }), deps)).rejects.toThrow(/its own change/);

    const pausedPreview: any = await executeMetaToolkitWrite('u1', upd({ status: 'PAUSED' }), deps);
    const res: any = await executeMetaToolkitWrite('u1', { ...upd({ status: 'ACTIVE' }), confirm: true, preview_token: pausedPreview.preview_token }, deps);
    expect(res.status).toBe('PREVIEW_MISMATCH');
    expect(res.preview).toContain('Status: ACTIVE');
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('ACTIVE with its own preview + confirm dispatches and reads back the status', async () => {
    const deps = makeDeps({ readBack: jest.fn().mockResolvedValue({ id: '999', status: 'ACTIVE', effective_status: 'ACTIVE' }) });
    const res: any = await previewThenConfirm(deps, { entity_type: 'CAMPAIGN', action: 'UPDATE', account_id: '111', campaign_id: '999', params: { status: 'ACTIVE' } });
    expect(res).toMatchObject({ success: true, verification: 'CONFIRMED', status: 'ACTIVE' });
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
  });

  it('a preview_token is single use', async () => {
    const deps = makeDeps();
    const preview: any = await executeMetaToolkitWrite('u1', createArgs(), deps);
    const confirm = { ...createArgs(), confirm: true, preview_token: preview.preview_token };
    const first: any = await executeMetaToolkitWrite('u1', confirm, deps);
    // ENG-2931: a repeat confirm replays the first outcome; it never dispatches again.
    await expect(executeMetaToolkitWrite('u1', confirm, deps)).resolves.toMatchObject({ verification: first.verification, replayed: true });
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
  });

  it('an expired token or changed arguments do not confirm', async () => {
    let now = NOW;
    const deps = makeDeps({ now: () => now });
    const preview: any = await executeMetaToolkitWrite('u1', createArgs(), deps);
    const changed: any = await executeMetaToolkitWrite('u1', { ...createArgs({ daily_budget: 500 }), confirm: true, preview_token: preview.preview_token }, deps);
    expect(changed.status).toBe('PREVIEW_MISMATCH');
    now = NOW + 16 * 60 * 1000;
    const expired: any = await executeMetaToolkitWrite('u1', { ...createArgs(), confirm: true, preview_token: preview.preview_token }, deps);
    expect(expired.status).toBe('PREVIEW_MISMATCH');
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('a token for another user does not confirm', async () => {
    const deps = makeDeps();
    const preview: any = await executeMetaToolkitWrite('u1', createArgs(), deps);
    const res: any = await executeMetaToolkitWrite('u2', { ...createArgs(), confirm: true, preview_token: preview.preview_token }, deps);
    expect(res.status).toBe('PREVIEW_MISMATCH');
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['USD', 50, '5000 (= $50.00)'],
    ['TWD', 500, '500 (= NT$500.00)'],
    ['JPY', 5000, '5000 (= ¥5,000.00)'],
  ])('echoes money in the account currency (%s)', async (currency, amount, echo) => {
    const deps = makeDeps({}, currency);
    const res: any = await executeMetaToolkitWrite('u1', createArgs({ daily_budget: amount }), deps);
    expect(res.preview).toContain(`daily_budget: ${echo}`);
  });

  it('an unsupported currency refuses the money write', async () => {
    const deps = makeDeps({}, 'XYZ');
    await expect(executeMetaToolkitWrite('u1', createArgs(), deps)).rejects.toThrow(/Unsupported or missing Meta ad account currency/);
    expect(deps.preview).not.toHaveBeenCalled();
  });

  it.each([
    [['ads_read'], /not granted the ads_management/],
    ['none', /cannot verify/],
  ])('requires a GRANTED ads_management scope (%p)', async (scopes, message) => {
    const deps = makeDeps({ listAccounts: jest.fn().mockResolvedValue([account(scopes)]) });
    await expect(executeMetaToolkitWrite('u1', createArgs(), deps)).rejects.toThrow(message);
    expect(deps.preview).not.toHaveBeenCalled();
  });

  it('enforces the spend ceiling in minor units, and fails closed on a malformed policy', async () => {
    const over = makeDeps({ spendCeilingPolicy: () => ({ maxDailyBudget: 4000 }) });
    await expect(executeMetaToolkitWrite('u1', createArgs(), over)).rejects.toThrow(/exceeds this account's max daily budget/);
    const bad = makeDeps({ spendCeilingPolicy: () => spendCeilingPolicyFromEnv('{not json') });
    await expect(executeMetaToolkitWrite('u1', createArgs(), bad)).rejects.toThrow(/could not be evaluated/);
    expect(spendCeilingPolicyFromEnv(undefined)).toBeNull();
  });

  it('read-back failure is UNCONFIRMED, not success', async () => {
    const deps = makeDeps({ readBack: jest.fn().mockRejectedValue(new Error('graph timeout')) });
    const res: any = await previewThenConfirm(deps, createArgs());
    expect(res.success).toBe(false);
    expect(res.verification).toBe('UNCONFIRMED');
    expect(res.message).toMatch(/^UNCONFIRMED/);
  });

  it('a budget that reads back different is MISMATCH, not success', async () => {
    const deps = makeDeps({ readBack: jest.fn().mockResolvedValue({ id: '999', status: 'PAUSED', daily_budget: '50' }) });
    const res: any = await previewThenConfirm(deps, createArgs());
    expect(res).toMatchObject({ success: false, verification: 'MISMATCH' });
  });

  it('a blocked/throttled dispatch is reported as FAILED', async () => {
    const deps = makeDeps({ dispatch: jest.fn().mockResolvedValue({ result: { success: false, throttled: true, retryAfterMs: 1000, message: 'slow down' } }) });
    const res: any = await previewThenConfirm(deps, createArgs());
    expect(res).toMatchObject({ status: 'FAILED', success: false, retry_after_ms: 1000 });
  });

  it('a preview the shared gate refuses is a refusal, not a preview', async () => {
    const deps = makeDeps({ preview: jest.fn().mockResolvedValue({ success: false, error: 'PARAM_VALIDATION_ERROR: objective required' }) });
    await expect(executeMetaToolkitWrite('u1', createArgs(), deps)).rejects.toThrow(/Not prepared, nothing was sent to Meta: PARAM_VALIDATION_ERROR/);
  });

  it('UPDATE is limited to status/budget fields and internal gate flags are refused', async () => {
    const deps = makeDeps();
    await expect(executeMetaToolkitWrite('u1', { entity_type: 'CAMPAIGN', action: 'UPDATE', account_id: '111', campaign_id: '1', params: { objective: 'OUTCOME_SALES' } }, deps))
      .rejects.toThrow(/can change only/);
    await expect(executeMetaToolkitWrite('u1', { entity_type: 'AD', action: 'UPDATE', account_id: '111', ad_id: '1', params: { daily_budget: 5 } }, deps))
      .rejects.toThrow(/can change only: status/);
    await expect(executeMetaToolkitWrite('u1', { entity_type: 'CAMPAIGN', action: 'UPDATE', account_id: '111', params: { status: 'PAUSED' } }, deps))
      .rejects.toThrow(/requires campaign_id/);
    await expect(executeMetaToolkitWrite('u1', createArgs({ override_tracking_check: true }), deps)).rejects.toThrow(/not available/);
    await expect(executeMetaToolkitWrite('u1', { ...createArgs(), client_id: 'other' }, deps)).rejects.toThrow(/client_id/);
    expect(deps.preview).not.toHaveBeenCalled();
  });
});

describe('ENG-2303 read-back node mapping', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readBackMetaNode } = require('../services/agentMode/metaToolkitSeams');
  const reader = {
    listCampaigns: jest.fn().mockResolvedValue({ campaigns: [{ id: 1, status: 'PAUSED', effective_status: 'PAUSED', daily_budget: '5000', name: 'x' }] }),
    listAdSets: jest.fn().mockResolvedValue({ adSets: [] }),
    getAd: jest.fn().mockResolvedValue({ id: '3', status: 'ACTIVE', effective_status: 'PENDING_REVIEW' }),
  };

  it('reads each entity ownership-scoped and maps status/effective_status/budgets', async () => {
    await expect(readBackMetaNode(reader, '111', 'tok', 'CAMPAIGN', '1')).resolves.toEqual({
      id: '1', status: 'PAUSED', effective_status: 'PAUSED', daily_budget: '5000', lifetime_budget: undefined, name: 'x', // ENG-2913: edit fields
    });
    expect(reader.listCampaigns).toHaveBeenCalledWith('111', 'tok', expect.objectContaining({ campaignId: '1' }));
    await expect(readBackMetaNode(reader, '111', 'tok', 'AD_SET', '2')).resolves.toBeNull();
    expect(reader.listAdSets).toHaveBeenCalledWith('111', 'tok', undefined, expect.objectContaining({ adSetId: '2' }));
    await expect(readBackMetaNode(reader, '111', 'tok', 'AD', '3')).resolves.toMatchObject({ effective_status: 'PENDING_REVIEW' });
    expect(reader.getAd).toHaveBeenCalledWith('tok', '3', '111');
  });
});
