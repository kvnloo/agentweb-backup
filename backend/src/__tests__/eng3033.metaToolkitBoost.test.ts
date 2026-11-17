// ENG-3033: ads_boost_ig_post — guarded write (preview + token), every entity created PAUSED.
jest.mock('../config/jwt', () => ({ getJwtSecret: () => 'test-secret' }));
jest.mock('../services/agentApiKeyService', () => ({ agentApiKeyService: { validateKey: jest.fn() } }));
jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: { validateAccessToken: jest.fn() } }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../services/mcpUsageEventsService', () => ({ recordMcpToolUse: jest.fn(), recordMcpWriteExecuted: jest.fn() }));
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: jest.fn().mockResolvedValue(null),
  attachPublishRevalidation: (_: unknown, context: unknown) => context,
}));
jest.mock('../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn().mockResolvedValue(undefined) }));

import { runMetaBoostTool, isMetaBoostTool, META_BOOST_TOOL_DEFINITIONS, type MetaBoostDeps } from '../mcp/metaToolkitBoost';
import { handleMetaToolkitCall, type MetaToolkitGatewayDeps } from '../mcp/metaToolkitGateway';
import { getMetaToolkitManifest } from '../mcp/metaToolkitManifest';
import { ZOMA_META_PARITY_MATRIX } from '../mcp/zomaMetaParityMatrix';
import { ZomaNotReadyError } from '../mcp/zomaOnboarding';

const NOW_MS = 1_800_000_000_000;
const TOOL = 'ads_boost_ig_post' as const;
const grantedAccount = {
  platform: 'meta', account_id: '123',
  config: { account_type: 'ad_account', ad_account_id: '123', access_token: 'x', granted_scopes: ['ads_management', 'ads_read'] },
};

interface Opts {
  igAccounts?: any[]; pages?: any[]; media?: any[]; ceiling?: any;
  failAt?: 'CAMPAIGN' | 'AD_SET' | 'AD'; throwAt?: 'CAMPAIGN' | 'AD_SET' | 'AD'; refusePreviewOf?: string;
  readBack?: (entity: string, id: string) => any; accounts?: any[]; creativeError?: any; notReady?: boolean;
}

function makeDeps(opts: Opts = {}) {
  const dispatched: any[] = [];
  const creatives: any[] = [];
  const reads: string[] = [];
  const ids: Record<string, string> = { CAMPAIGN: '1001', AD_SET: '2001', AD: '4001' };
  const deps: MetaBoostDeps = {
    assertReady: async () => { if (opts.notReady) throw new ZomaNotReadyError('Add a payment method first.'); },
    listAccounts: async () => (opts.accounts ?? [grantedAccount]) as any,
    readGraph: jest.fn(async (_u: string, _a: string, path: string) => {
      reads.push(path);
      if (path === 'act_123/instagram_accounts') return { data: opts.igAccounts ?? [{ id: '555', username: 'shop' }] };
      if (path === 'act_123/promote_pages') return { data: opts.pages ?? [{ id: '777', name: 'Shop Page' }] };
      if (path === '555/media') return { data: opts.media ?? [{ id: '9001', permalink: 'https://instagram.com/p/x', media_type: 'IMAGE' }] };
      throw new Error(`unexpected read ${path}`);
    }) as any,
    previewMoney: async (_u, _a, params) => ({ params: { daily_budget: Math.round(params.daily_budget * 100) }, currency: 'USD', confirmation: ` (money submitted: daily_budget: ${params.daily_budget * 100} (= $${params.daily_budget.toFixed(2)}))` }),
    preview: jest.fn(async (_u: string, entity: string, action: string, accountId: string, campaignId?: string, adSetId?: string, _ad?: string, params?: any) => {
      if (opts.refusePreviewOf === entity) return { success: false, error: `${entity} gate refused` };
      return { awaitingUserConfirmation: true, summary: `${action} ${entity}`, metaWriteDispatch: { entity_type: entity, action, account_id: accountId, campaign_id: campaignId, ad_set_id: adSetId, params } };
    }) as any,
    dispatch: jest.fn(async (_u: string, d: any) => {
      if (opts.throwAt === d.entity_type) throw new Error('socket hang up');
      if (opts.failAt === d.entity_type) return { result: { success: false, error: 'Invalid parameter', code: 100 } };
      dispatched.push(d);
      return { result: { success: true }, createdId: ids[d.entity_type] };
    }) as any,
    createCreative: jest.fn(async (_u: string, _a: string, spec: any) => {
      if (opts.creativeError) throw opts.creativeError;
      creatives.push(spec);
      return { id: '3001' };
    }) as any,
    readBack: jest.fn(async (_u: string, _a: string, entity: string, id: string) => (
      opts.readBack ? opts.readBack(entity, id) : { id, status: 'PAUSED', ...(entity === 'AD_SET' ? { daily_budget: '2000', campaign_id: '1001' } : {}) }
    )) as any,
    spendCeilingPolicy: () => opts.ceiling ?? null,
    secret: () => 'test-secret',
    now: () => NOW_MS,
    consumedTokens: new Map(),
    tokenOutcomes: new Map(),
  };
  return { deps, dispatched, creatives, reads };
}

const args = { ig_account_id: '555', ig_media_id: '9001', page_id: '777', daily_budget: 20, countries: ['US'] };
const run = (a: any, deps: MetaBoostDeps, user = 'u1') => runMetaBoostTool(TOOL, user, '123', a, deps);
const confirmed = async (deps: MetaBoostDeps, a: any = args) => {
  const preview: any = await run(a, deps);
  return run({ ...a, confirm: true, preview_token: preview.preview_token }, deps) as Promise<any>;
};

describe('ENG-3033 ads_boost_ig_post', () => {
  it('AC1: a preview shows what would be created, returns a token and creates nothing', async () => {
    const { deps, dispatched, creatives } = makeDeps();
    const preview: any = await run(args, deps);
    expect(preview.status).toBe('PREVIEW');
    expect(preview.success).toBe(false);
    expect(typeof preview.preview_token).toBe('string');
    expect(preview.preview).toMatch(/nothing has changed yet/);
    expect(preview.preview).toMatch(/1 campaign .*1 ad set and 1 ad/);
    expect(preview.preview).toMatch(/\$20\.00/);
    expect(preview.preview).toMatch(/PAUSED/);
    expect(preview.boost_spec).toMatchObject({ ig_media_id: '9001', daily_budget: 20, countries: ['US'], age_min: 18, age_max: 65 });
    expect(dispatched).toHaveLength(0);
    expect(creatives).toHaveLength(0);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('AC1/AC2/AC4: confirm with the valid token creates campaign, ad set, creative and ad, all PAUSED, CONFIRMED by read-back', async () => {
    const { deps, dispatched, creatives } = makeDeps();
    const done = await confirmed(deps, { ...args, duration_days: 7 });
    expect(done).toMatchObject({ success: true, verification: 'CONFIRMED', id: '4001', created: { campaign_id: '1001', ad_set_id: '2001', creative_id: '3001', ad_id: '4001' } });
    expect(dispatched.map((d) => d.entity_type)).toEqual(['CAMPAIGN', 'AD_SET', 'AD']);
    for (const d of dispatched) expect(d.params.status).toBe('PAUSED');
    expect(dispatched[0].params).toMatchObject({ objective: 'OUTCOME_ENGAGEMENT' });
    expect(dispatched[1]).toMatchObject({ campaign_id: '1001', params: { daily_budget: 20, targeting: { geo_locations: { countries: ['US'] }, age_min: 18, age_max: 65 } } });
    expect(dispatched[1].params.end_time).toBe(new Date(NOW_MS + 7 * 86_400_000).toISOString());
    expect(dispatched[2]).toMatchObject({ campaign_id: '1001', ad_set_id: '2001', params: { creative_id: '3001' } });
    expect(creatives).toEqual([{ name: 'Boost Instagram post 9001', page_id: '777', ig_account_id: '555', ig_media_id: '9001' }]);
  });

  it('AC1: a missing, forged or argument-mismatched token creates nothing', async () => {
    const { deps, dispatched } = makeDeps();
    expect(((await run({ ...args, confirm: true }, deps)) as any).status).toBe('PREVIEW_MISMATCH');
    expect(((await run({ ...args, confirm: true, preview_token: 'v1.9999999999999.x' }, deps)) as any).status).toBe('PREVIEW_MISMATCH');
    const preview: any = await run(args, deps);
    const changed: any = await run({ ...args, daily_budget: 500, confirm: true, preview_token: preview.preview_token }, deps);
    expect(changed.status).toBe('PREVIEW_MISMATCH');
    const otherUser: any = await run({ ...args, confirm: true, preview_token: preview.preview_token }, deps, 'u2');
    expect(otherUser.status).toBe('PREVIEW_MISMATCH');
    expect(dispatched).toHaveLength(0);
  });

  it('AC7: a reused token is refused as a new write (the first outcome is replayed, nothing is created twice)', async () => {
    const { deps, dispatched, creatives } = makeDeps();
    const preview: any = await run(args, deps);
    const call = { ...args, confirm: true, preview_token: preview.preview_token };
    await run(call, deps);
    const again: any = await run(call, deps);
    expect(again.replayed).toBe(true);
    expect(dispatched).toHaveLength(3);
    expect(creatives).toHaveLength(1);
    // With no remembered outcome (another process), the reused token is refused outright.
    deps.tokenOutcomes.clear();
    await expect(run(call, deps)).rejects.toThrow(/already used/);
    expect(dispatched).toHaveLength(3);
  });

  it('AC2: no argument can create an ACTIVE entity', async () => {
    const { deps, dispatched } = makeDeps();
    await expect(run({ ...args, status: 'ACTIVE' }, deps)).rejects.toThrow(/Not allowed: status/);
    await expect(run({ ...args, params: { status: 'ACTIVE' } }, deps)).rejects.toThrow(/Not allowed: params/);
    expect(dispatched).toHaveLength(0);
    expect(Object.keys(META_BOOST_TOOL_DEFINITIONS[0].inputSchema.properties)).not.toContain('status');
    expect(META_BOOST_TOOL_DEFINITIONS[0].inputSchema.additionalProperties).toBe(false);
  });

  it('AC3: an over-ceiling budget is refused at preview, before the shared gate and any write', async () => {
    const { deps, dispatched } = makeDeps({ ceiling: { maxDailyBudget: 1000 } });
    await expect(run(args, deps)).rejects.toThrow(/exceeds this account's max daily budget/);
    expect(deps.preview).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
    // At the ceiling is allowed.
    const ok: any = await run({ ...args, daily_budget: 10 }, deps);
    expect(ok.status).toBe('PREVIEW');
  });

  it('AC3: a malformed ceiling policy fails closed', async () => {
    const { deps } = makeDeps({ ceiling: { maxChangeRatio: -1 } });
    await expect(run(args, deps)).rejects.toThrow(/could not be evaluated/);
  });

  it('AC5: refuses an Instagram account, Page or post that is not the ad account\'s own, before any write', async () => {
    const a = makeDeps({ igAccounts: [{ id: '556' }] });
    await expect(run(args, a.deps)).rejects.toThrow(/Instagram account 555 is not available to this ad account/);
    expect(a.reads).not.toContain('555/media');
    const b = makeDeps({ pages: [{ id: '778' }] });
    await expect(run(args, b.deps)).rejects.toThrow(/Page 777 is not one this ad account can promote/);
    const c = makeDeps({ media: [{ id: '9002' }] });
    await expect(run(args, c.deps)).rejects.toThrow(/Post 9001 was not found/);
    for (const x of [a, b, c]) {
      expect(x.deps.preview).not.toHaveBeenCalled();
      expect(x.deps.dispatch).not.toHaveBeenCalled();
      expect(x.deps.createCreative).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])('AC5: foreign Instagram ownership takes precedence over a missing ads_management grant (confirm=%s)', async (confirm) => {
    const { deps, reads } = makeDeps({
      igAccounts: [{ id: '556' }],
      accounts: [{ ...grantedAccount, config: { ...grantedAccount.config, granted_scopes: ['ads_read'] } }],
    });
    await expect(run({ ...args, confirm }, deps)).rejects.toThrow(/Instagram account 555 is not available to this ad account/);
    expect(reads).toEqual(['act_123/instagram_accounts']);
    expect(deps.preview).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.createCreative).not.toHaveBeenCalled();
  });

  it('AC5: ownership is re-checked at confirm, so a post removed after the preview is not boosted', async () => {
    const { deps, dispatched } = makeDeps();
    const preview: any = await run(args, deps);
    (deps.readGraph as jest.Mock).mockImplementation(async (_u: string, _a: string, path: string) => (
      path === '555/media' ? { data: [] } : { data: [{ id: path.endsWith('instagram_accounts') ? '555' : '777' }] }
    ));
    await expect(run({ ...args, confirm: true, preview_token: preview.preview_token }, deps)).rejects.toThrow(/was not found/);
    expect(dispatched).toHaveLength(0);
  });

  it('AC4/AC7: read-back mismatch is reported as MISMATCH, never success (an ACTIVE entity is named)', async () => {
    const { deps } = makeDeps({ readBack: (entity, id) => ({ id, status: entity === 'AD' ? 'ACTIVE' : 'PAUSED', ...(entity === 'AD_SET' ? { daily_budget: '9999', campaign_id: '1001' } : {}) }) });
    const done = await confirmed(deps);
    expect(done).toMatchObject({ success: false, verification: 'MISMATCH' });
    expect(done.message).toMatch(/ad status ACTIVE/);
    expect(done.message).toMatch(/ad set daily_budget/);
  });

  it('AC4: a failed read-back is UNCONFIRMED', async () => {
    const { deps } = makeDeps({ readBack: () => { throw new Error('boom'); } });
    expect(await confirmed(deps)).toMatchObject({ success: false, verification: 'UNCONFIRMED', created: { ad_id: '4001' } });
  });

  it('a definite refusal of the campaign is FAILED with nothing created and no verdict', async () => {
    const { deps, dispatched } = makeDeps({ failAt: 'CAMPAIGN' });
    const done = await confirmed(deps);
    expect(done).toMatchObject({ status: 'FAILED', success: false, created: {} });
    expect(done.verification).toBeUndefined();
    expect(done.message).toMatch(/Nothing was created/);
    expect(dispatched).toHaveLength(0);
  });

  it('a refusal part-way stops, reports what exists (PAUSED) and is not success', async () => {
    const { deps, dispatched, creatives } = makeDeps({ failAt: 'AD_SET' });
    const done = await confirmed(deps);
    expect(done).toMatchObject({ status: 'PARTIAL', success: false, verification: 'UNCONFIRMED', created: { campaign_id: '1001' } });
    expect(done.message).toMatch(/campaign 1001/);
    expect(done.message).toMatch(/PAUSED/);
    expect(dispatched.map((d) => d.entity_type)).toEqual(['CAMPAIGN']);
    expect(creatives).toHaveLength(0);
  });

  it('a transport failure is UNCONFIRMED and stops the boost', async () => {
    const { deps, dispatched } = makeDeps({ throwAt: 'AD' });
    const done = await confirmed(deps);
    expect(done).toMatchObject({ success: false, verification: 'UNCONFIRMED', created: { campaign_id: '1001', ad_set_id: '2001', creative_id: '3001' } });
    expect(done.status).toBeUndefined();
    expect(dispatched.map((d) => d.entity_type)).toEqual(['CAMPAIGN', 'AD_SET']);
  });

  it('a creative refused by Meta stops before the ad', async () => {
    const err: any = new Error('Invalid media'); err.metaError = { code: 100, message: 'Invalid media' }; err.outcomeUnknown = false;
    const { deps, dispatched } = makeDeps({ creativeError: err });
    const done = await confirmed(deps);
    expect(done).toMatchObject({ status: 'PARTIAL', success: false });
    expect(done.message).toMatch(/Invalid media/);
    expect(dispatched.map((d) => d.entity_type)).toEqual(['CAMPAIGN', 'AD_SET']);
  });

  it('refuses when Zoma is not write-ready, the connection lacks ads_management, or the shared gate refuses', async () => {
    await expect(run(args, makeDeps({ notReady: true }).deps)).rejects.toThrow(/payment method/);
    const noScope = makeDeps({ accounts: [{ ...grantedAccount, config: { ...grantedAccount.config, granted_scopes: ['ads_read'] } }] });
    await expect(run(args, noScope.deps)).rejects.toThrow(/ads_management/);
    expect(noScope.reads).toEqual(['act_123/instagram_accounts', 'act_123/promote_pages', '555/media']);
    expect(noScope.deps.preview).not.toHaveBeenCalled();
    expect(noScope.deps.dispatch).not.toHaveBeenCalled();
    expect(noScope.deps.createCreative).not.toHaveBeenCalled();
    await expect(run(args, makeDeps({ refusePreviewOf: 'CAMPAIGN' }).deps)).rejects.toThrow(/CAMPAIGN gate refused/);
  });

  it('validates arguments', async () => {
    const { deps } = makeDeps();
    await expect(run({ ...args, daily_budget: 0 }, deps)).rejects.toThrow(/daily_budget/);
    await expect(run({ ...args, daily_budget: '20' }, deps)).rejects.toThrow(/daily_budget/);
    await expect(run({ ...args, countries: [] }, deps)).rejects.toThrow(/countries/);
    await expect(run({ ...args, countries: ['usa'] }, deps)).rejects.toThrow(/countries/);
    await expect(run({ ...args, age_min: 17 }, deps)).rejects.toThrow(/age_min/);
    await expect(run({ ...args, age_min: 40, age_max: 30 }, deps)).rejects.toThrow(/age_min/);
    await expect(run({ ...args, duration_days: 91 }, deps)).rejects.toThrow(/duration_days/);
    await expect(run({ ...args, ig_media_id: '9001/../x' }, deps)).rejects.toThrow(/ig_media_id/);
    expect(deps.readGraph).not.toHaveBeenCalled();
  });
});

describe('ENG-3033 gateway, manifest and matrix', () => {
  function gateway(scopes: string[], result: any = { status: 'PREVIEW' }) {
    const raw = {
      validateApiKey: jest.fn().mockResolvedValue({ userId: 'u1', keyId: 'k1', scopes }),
      validateOAuthToken: jest.fn(),
      listAccounts: jest.fn().mockResolvedValue([grantedAccount]),
      execute: jest.fn(),
      recordUsage: jest.fn().mockResolvedValue(undefined),
      recordWrite: jest.fn().mockResolvedValue(undefined),
      now: () => Date.parse('2026-11-15T00:00:00Z'),
      rateLimiter: { check: () => ({ allowed: true, remaining: 1, resetInMs: 0 }) },
      runBoostTool: jest.fn().mockResolvedValue(result),
    };
    return { deps: raw as unknown as MetaToolkitGatewayDeps, raw };
  }
  const call = (a: any = args) => ({ authorization: 'Bearer aw_fixture', toolName: TOOL, args: a });

  it('AC6: a read-only key gets 403 with no upstream call and no metering', async () => {
    const { deps, raw } = gateway(['tools:read']);
    await expect(handleMetaToolkitCall(call(), deps)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('tools:execute') });
    expect(raw.runBoostTool).not.toHaveBeenCalled();
    expect(raw.recordUsage).not.toHaveBeenCalled();
  });

  it('AC7: a foreign ad account is refused 403 before the tool runs', async () => {
    const { deps, raw } = gateway(['tools:read', 'tools:execute']);
    await expect(handleMetaToolkitCall(call({ ...args, account_id: '999' }), deps)).rejects.toMatchObject({ status: 403 });
    expect(raw.runBoostTool).not.toHaveBeenCalled();
    expect(raw.recordUsage).not.toHaveBeenCalled();
  });

  it('a preview is metered once as usage and not as a write; an executed boost is also recorded as one write', async () => {
    const p = gateway(['tools:read', 'tools:execute']);
    await handleMetaToolkitCall(call(), p.deps);
    expect(p.raw.runBoostTool).toHaveBeenCalledWith(TOOL, 'u1', '123', expect.objectContaining({ ig_media_id: '9001' }));
    expect(p.raw.recordUsage).toHaveBeenCalledTimes(1);
    expect(p.raw.recordWrite).not.toHaveBeenCalled();
    const w = gateway(['tools:read', 'tools:execute'], { success: true, verification: 'CONFIRMED', id: '4001' });
    await handleMetaToolkitCall(call(), w.deps);
    expect(w.raw.recordUsage).toHaveBeenCalledTimes(1);
    expect(w.raw.recordWrite).toHaveBeenCalledTimes(1);
    expect(w.raw.recordWrite).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'AD', action: 'CREATE', verification: 'CONFIRMED', objectId: '4001' }));
  });

  it('is advertised in the manifest and AC8: the matrix row is covered', () => {
    expect(isMetaBoostTool(TOOL)).toBe(true);
    expect(getMetaToolkitManifest().map((d: any) => d.name)).toContain(TOOL);
    expect((ZOMA_META_PARITY_MATRIX as any[]).find((r) => r.metaTool === TOOL)).toMatchObject({ status: 'covered', zoma: { tool: TOOL } });
  });
});
