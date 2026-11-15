process.env.ZOMA_REQUIRE_PAYMENT_METHOD = 'true';
/**
 * ENG-3034 acceptance contract (base Campaign-management parity rows):
 *  1. ads_create_campaign / ads_create_ad_set / ads_create_ad / ads_activate_entity map to
 *     an operation the Zoma manifest really advertises.
 *  4. Before a create or activate row counts as covered: the path creates every entity
 *     PAUSED, and activation goes through the write guard (its own preview + token).
 *     Proven here per entity, because eng2303 only exercises CAMPAIGN.
 *  ads_get_field_context stays a gap, owned by ENG-3040 (ads_get_ad_accounts is its own read tool since ENG-3040).
 */
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../mcp/zomaOnboarding', () => {
  const actual = jest.requireActual('../mcp/zomaOnboarding');
  return { ...actual, assertZomaWriteReady: jest.fn() };
});
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    listMetaAdsCampaignsNew: jest.fn(),
    getMetaAdsMetrics: jest.fn(),
    callMetaAdsInsightsApiWrapper: jest.fn(),
    callMetaMarketingApi: jest.fn(),
    launchTargetedAudienceCampaign: jest.fn(),
    launchRetargetingCampaign: jest.fn(),
  },
}));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: jest.fn().mockResolvedValue(null),
  attachPublishRevalidation: (_: unknown, context: unknown) => context,
}));
jest.mock('../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn().mockResolvedValue(undefined) }));

import { getMetaToolkitManifest } from '../mcp/metaToolkitManifest';
import { executeMetaToolkitWrite, type MetaToolkitWriteDeps } from '../mcp/metaToolkitWrites';
import { ZOMA_META_PARITY_MATRIX, summarizeParity } from '../mcp/zomaMetaParityMatrix';

const row = (name: string) => ZOMA_META_PARITY_MATRIX.find((r) => r.metaTool === name)!;

const ENTITIES = ['CAMPAIGN', 'AD_SET', 'AD'] as const;
type Entity = (typeof ENTITIES)[number];
const ID_FIELD: Record<Entity, string> = { CAMPAIGN: 'campaign_id', AD_SET: 'ad_set_id', AD: 'ad_id' };
const CREATE_ARGS: Record<Entity, any> = {
  CAMPAIGN: { params: { name: 'Phoenix Leads', objective: 'OUTCOME_LEADS', daily_budget: 50 } },
  AD_SET: { campaign_id: '555', params: { name: 'Phoenix 25-54', daily_budget: 20, optimization_goal: 'LEAD_GENERATION', billing_event: 'IMPRESSIONS' } },
  AD: { ad_set_id: '666', params: { name: 'Phoenix ad 1', creative_id: '777' } },
};

const pausedReadBack = (entity: Entity) => {
  const budget = CREATE_ARGS[entity].params.daily_budget;
  return { id: '999', status: 'PAUSED', effective_status: 'PAUSED', ...(budget === undefined ? {} : { daily_budget: String(budget * 100) }) };
};

function makeDeps(entity: Entity, over: Partial<MetaToolkitWriteDeps> = {}) {
  const deps: MetaToolkitWriteDeps = {
    assertReady: jest.fn().mockResolvedValue(undefined),
    listAccounts: jest.fn().mockResolvedValue([{
      platform: 'meta', account_id: 'act_111',
      config: { account_type: 'ad_account', access_token: 'tok', ad_account_id: '111', granted_scopes: ['ads_read', 'ads_management'] },
    }]),
    // USD: major units in, cents to Meta (same conversion the real writer applies).
    previewMoney: jest.fn(async (_u: string, _a: string, params: any) => ({
      params: { ...params, ...(params.daily_budget === undefined ? {} : { daily_budget: params.daily_budget * 100 }) },
      currency: 'USD',
      confirmation: '',
    })),
    preview: jest.fn(async (_u: string, entity: string, action: string, accountId: string, c?: string, as?: string, ad?: string, params?: any) => ({
      success: true,
      awaitingUserConfirmation: true,
      summary: `${action} ${entity} on ${accountId}`,
      metaWriteManifestDigest: 'internal-digest',
      metaWriteDispatch: { entity_type: entity, action, account_id: accountId, resolvedAccountId: accountId, campaign_id: c, ad_set_id: as, ad_id: ad, params },
    })),
    dispatch: jest.fn().mockResolvedValue({ result: { success: true, message: 'created' }, createdId: '999' }),
    readBack: jest.fn().mockResolvedValue(pausedReadBack(entity)),
    assertCreativeOwned: jest.fn().mockResolvedValue(undefined),
    spendCeilingPolicy: () => null,
    secret: () => 'test-secret',
    now: () => 1_800_000_000_000,
    consumedTokens: new Map(),
    ...over,
  } as MetaToolkitWriteDeps;
  return deps as MetaToolkitWriteDeps & Record<string, jest.Mock>;
}

const create = (entity: Entity, extra: any = {}) => ({
  entity_type: entity, action: 'CREATE', account_id: '111', ...CREATE_ARGS[entity],
  params: { ...CREATE_ARGS[entity].params, ...extra },
});
const activate = (entity: Entity) => ({ entity_type: entity, action: 'UPDATE', account_id: '111', [ID_FIELD[entity]]: '999', params: { status: 'ACTIVE' } });

describe('ENG-3034 Campaign-management parity rows', () => {
  const mma: any = getMetaToolkitManifest().find((d: any) => d.name === 'call_meta_marketing_api');
  const actions: string[] = mma.inputSchema.properties.action.enum;
  const entityTypes: string[] = mma.inputSchema.properties.entity_type.enum;

  it.each([
    ['ads_create_campaign', 'CAMPAIGN'],
    ['ads_create_ad_set', 'AD_SET'],
    ['ads_create_ad', 'AD'],
  ])('%s is covered by an advertised call_meta_marketing_api CREATE on %s', (name, entity) => {
    expect(row(name)).toMatchObject({ status: 'covered', zoma: { tool: 'call_meta_marketing_api', action: 'CREATE', entityType: entity } });
    expect(actions).toContain('CREATE');
    expect(entityTypes).toContain(entity);
  });

  it('ads_activate_entity is covered by the advertised guarded UPDATE, and the description says activation is its own approval', () => {
    expect(row('ads_activate_entity')).toMatchObject({ status: 'covered', zoma: { tool: 'call_meta_marketing_api', action: 'UPDATE' } });
    expect(actions).toContain('UPDATE');
    expect(mma.description).toContain('always created PAUSED');
    expect(mma.description).toContain('activating (status=ACTIVE) is its own separate preview and approval');
  });

  it('ads_get_field_context stays a gap owned by ENG-3040 (ads_get_ad_accounts moved to eng3040.adAccounts.test.ts)', () => {
    const names = new Set(getMetaToolkitManifest().map((d: any) => d.name));
    expect(row('ads_get_field_context')).toMatchObject({ status: 'gap', owner: 'ENG-3040' });
    expect(names.has('ads_get_field_context')).toBe(false);
  });

  it('Campaign management totals: 7 covered, 1 gap', () => {
    const cm = summarizeParity().find((r: any) => r.category === 'Campaign management');
    expect(cm).toMatchObject({ covered: 7, gap: 1 });
  });

  describe.each(ENTITIES)('%s through the write guard', (entity) => {
    it('CREATE previews first, then is dispatched and read back PAUSED', async () => {
      const deps = makeDeps(entity);
      const preview: any = await executeMetaToolkitWrite('u1', create(entity), deps);
      expect(preview.status).toBe('PREVIEW');
      expect(deps.dispatch).not.toHaveBeenCalled();
      expect((deps.preview as jest.Mock).mock.calls[0][7].status).toBe('PAUSED');

      const res: any = await executeMetaToolkitWrite('u1', { ...create(entity), confirm: true, preview_token: preview.preview_token }, deps);
      expect((deps.dispatch as jest.Mock).mock.calls[0][1].params.status).toBe('PAUSED');
      expect(res).toMatchObject({ success: true, verification: 'CONFIRMED', status: 'PAUSED' });
    });

    it.each(['ACTIVE', 'ARCHIVED', 'active'])('CREATE with status %s is refused before any preview or dispatch', async (status) => {
      const deps = makeDeps(entity);
      await expect(executeMetaToolkitWrite('u1', create(entity, { status }), deps)).rejects.toThrow(/always created PAUSED/);
      expect(deps.preview).not.toHaveBeenCalled();
      expect(deps.dispatch).not.toHaveBeenCalled();
    });

    it('a created entity that reads back ACTIVE is not reported as success', async () => {
      const deps = makeDeps(entity, { readBack: jest.fn().mockResolvedValue({ ...pausedReadBack(entity), status: 'ACTIVE', effective_status: 'ACTIVE' }) });
      const preview: any = await executeMetaToolkitWrite('u1', create(entity), deps);
      const res: any = await executeMetaToolkitWrite('u1', { ...create(entity), confirm: true, preview_token: preview.preview_token }, deps);
      expect(res.success).toBe(false);
      expect(res.verification).toBe('MISMATCH');
    });

    it('activation without its own preview token dispatches nothing; the CREATE token does not activate', async () => {
      const deps = makeDeps(entity);
      const noToken: any = await executeMetaToolkitWrite('u1', { ...activate(entity), confirm: true }, deps);
      expect(noToken.status).toBe('PREVIEW_MISMATCH');

      const createPreview: any = await executeMetaToolkitWrite('u1', create(entity), deps);
      const reused: any = await executeMetaToolkitWrite('u1', { ...activate(entity), confirm: true, preview_token: createPreview.preview_token }, deps);
      expect(reused.status).toBe('PREVIEW_MISMATCH');
      expect(deps.dispatch).not.toHaveBeenCalled();
    });

    it('activation with its own preview and token dispatches once and reads back ACTIVE', async () => {
      const deps = makeDeps(entity, { readBack: jest.fn().mockResolvedValue({ id: '999', status: 'ACTIVE', effective_status: 'ACTIVE' }) });
      const preview: any = await executeMetaToolkitWrite('u1', activate(entity), deps);
      expect(preview.status).toBe('PREVIEW');
      expect(preview.preview).toContain('Status: ACTIVE');
      expect(deps.dispatch).not.toHaveBeenCalled();
      const res: any = await executeMetaToolkitWrite('u1', { ...activate(entity), confirm: true, preview_token: preview.preview_token }, deps);
      expect(res).toMatchObject({ success: true, verification: 'CONFIRMED', status: 'ACTIVE' });
      expect(deps.dispatch).toHaveBeenCalledTimes(1);
    });
  });
});
