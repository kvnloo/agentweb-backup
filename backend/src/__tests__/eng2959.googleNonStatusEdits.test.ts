/**
 * ENG-2959 — Google toolkit CAMPAIGN rename and AD_GROUP rename / max CPC through the guarded
 * preview gateway. Status stays its own call; nothing else on UPDATE is widened. Handler calls
 * are mocked; no live Google calls.
 */
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: jest.fn().mockResolvedValue(null),
  attachPublishRevalidation: (_: unknown, context: unknown) => context,
}));
jest.mock('../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../emma/impl/adsCrmApis', () => ({
  handleCallGoogleAdsApi: jest.fn().mockResolvedValue({ success: true }),
  handleCallGoogleAdsReportingApi: jest.fn().mockResolvedValue({ success: true, results: [] }),
}));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));

import { getGoogleToolkitManifest } from '../mcp/googleToolkitManifest';
import { executeGoogleToolkitWrite, mapGoogleReadRow, type GoogleToolkitWriteDeps } from '../mcp/googleToolkitWrites';
import { handleMetaToolkitCall, type MetaToolkitGatewayDeps } from '../mcp/metaToolkitGateway';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';

const NOW = Date.parse('2026-11-12T00:00:00Z');
const CID = '1234567890';
const CAMPAIGN = `customers/${CID}/campaigns/77`;
const AD_GROUP = `customers/${CID}/adGroups/66`;
const FOREIGN_AD_GROUP = 'customers/9999999999/adGroups/66';

function writeDeps(apply: (args: any, state: Record<string, any>) => void = defaultApply) {
  const state: Record<string, any> = {
    [CAMPAIGN]: { resourceName: CAMPAIGN, name: 'Search', status: 'PAUSED', budget: `customers/${CID}/campaignBudgets/55`, channelType: 'SEARCH' },
    [AD_GROUP]: { resourceName: AD_GROUP, name: 'Shoes', status: 'ENABLED', campaign: CAMPAIGN, cpcBidMicros: 1_000_000 },
  };
  const deps: GoogleToolkitWriteDeps & { state: Record<string, any> } = {
    state,
    assertReady: jest.fn().mockResolvedValue(undefined),
    read: jest.fn(async (_u: string, _c: string, _k: string, rn: string) => (state[rn] ? { ...state[rn] } : null)),
    dispatch: jest.fn(async (_u: string, args: any) => { apply(args, state); return { success: true, message: 'ok' }; }),
    resolveImageUrl: jest.fn(),
    spendCeilingPolicy: () => null,
    secret: () => 'test-secret',
    now: () => NOW,
    consumedTokens: new Map(),
  } as any;
  return deps;
}

function defaultApply(args: any, state: Record<string, any>) {
  const rn = args.campaign_resource_name ?? args.ad_group_resource_name;
  if (args.name !== undefined) state[rn].name = args.name;
  if (args.cpc_bid_micros !== undefined) state[rn].cpcBidMicros = args.cpc_bid_micros;
  if (args.status !== undefined) state[rn].status = args.status;
}

async function approve(d: GoogleToolkitWriteDeps, args: any) {
  const preview: any = await executeGoogleToolkitWrite('u1', args, 'USD', d);
  expect(preview.status).toBe('PREVIEW');
  expect(d.dispatch).not.toHaveBeenCalled();
  const result: any = await executeGoogleToolkitWrite('u1', { ...args, confirm: true, preview_token: preview.preview_token }, 'USD', d);
  return { preview, result };
}

const base = { customer_id: CID };

describe('ENG-2959 CAMPAIGN rename', () => {
  it('preview shows current vs new name, status unchanged; confirm dispatches once and read-back CONFIRMS', async () => {
    const d = writeDeps();
    const args = { ...base, entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_resource_name: CAMPAIGN, name: '  Search – Brand ' };
    const { preview, result } = await approve(d, args);
    expect(preview.preview).toContain('Name: "Search" → "Search – Brand"');
    expect(preview.preview).toContain('Status: unchanged.');
    expect(d.dispatch).toHaveBeenCalledTimes(1);
    expect((d.dispatch as jest.Mock).mock.calls[0][1]).toEqual({
      customer_id: CID, entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_resource_name: CAMPAIGN, name: 'Search – Brand',
    });
    expect(result).toMatchObject({ success: true, verification: 'CONFIRMED', id: CAMPAIGN });
  });

  it('Google accepts but the name does not read back → MISMATCH, never success', async () => {
    const d = writeDeps(() => undefined);
    const { result } = await approve(d, { ...base, entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_resource_name: CAMPAIGN, name: 'New' });
    expect(result).toMatchObject({ success: false, verification: 'MISMATCH' });
  });

  it('a token for one name cannot confirm a different name', async () => {
    const d = writeDeps();
    const args = { ...base, entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_resource_name: CAMPAIGN, name: 'A' };
    const preview: any = await executeGoogleToolkitWrite('u1', args, 'USD', d);
    const r: any = await executeGoogleToolkitWrite('u1', { ...args, name: 'B', confirm: true, preview_token: preview.preview_token }, 'USD', d);
    expect(r.status).toBe('PREVIEW_MISMATCH');
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('cpc_bid is not a CAMPAIGN UPDATE field', async () => {
    const d = writeDeps();
    await expect(executeGoogleToolkitWrite('u1', { ...base, entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_resource_name: CAMPAIGN, cpc_bid: 2 }, 'USD', d))
      .rejects.toThrow(/Not allowed: cpc_bid/);
  });
});

describe('ENG-2959 AD_GROUP name / max CPC', () => {
  it('preview shows current vs new CPC in currency and micros; dispatch carries micros; read-back CONFIRMS', async () => {
    const d = writeDeps();
    const args = { ...base, entity_type: 'AD_GROUP', action: 'UPDATE', ad_group_resource_name: AD_GROUP, name: 'Running shoes', cpc_bid: 2.5 };
    const { preview, result } = await approve(d, args);
    expect(preview.preview).toContain('Name: "Shoes" → "Running shoes"');
    expect(preview.preview).toMatch(/Max CPC: .*1\.00.*\(= 1000000 micros\) → .*2\.50.*\(= 2500000 micros\)/);
    expect((d.dispatch as jest.Mock).mock.calls[0][1]).toEqual({
      customer_id: CID, entity_type: 'AD_GROUP', action: 'UPDATE', ad_group_resource_name: AD_GROUP, name: 'Running shoes', cpc_bid_micros: 2_500_000,
    });
    expect(result).toMatchObject({ success: true, verification: 'CONFIRMED' });
    expect(d.state[AD_GROUP].status).toBe('ENABLED');
  });

  it('CPC read back differently → MISMATCH; CPC missing on read-back → UNCONFIRMED', async () => {
    const off = writeDeps((args, s) => { s[AD_GROUP].cpcBidMicros = args.cpc_bid_micros + 10_000; });
    const a = { ...base, entity_type: 'AD_GROUP', action: 'UPDATE', ad_group_resource_name: AD_GROUP, cpc_bid: 3 };
    expect((await approve(off, a)).result).toMatchObject({ success: false, verification: 'MISMATCH' });
    const gone = writeDeps((_args, s) => { delete s[AD_GROUP].cpcBidMicros; });
    expect((await approve(gone, a)).result).toMatchObject({ success: false, verification: 'UNCONFIRMED' });
  });

  it.each([0, -1, 'x', Number.NaN])('cpc_bid %p is refused before readiness', async (bid) => {
    const d = writeDeps();
    await expect(executeGoogleToolkitWrite('u1', { ...base, entity_type: 'AD_GROUP', action: 'UPDATE', ad_group_resource_name: AD_GROUP, cpc_bid: bid }, 'USD', d))
      .rejects.toBeInstanceOf(MetaToolkitRefusal);
    expect(d.assertReady).not.toHaveBeenCalled();
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('cpc_bid_micros is refused with a pointer to cpc_bid (major units)', async () => {
    const d = writeDeps();
    await expect(executeGoogleToolkitWrite('u1', { ...base, entity_type: 'AD_GROUP', action: 'UPDATE', ad_group_resource_name: AD_GROUP, cpc_bid_micros: 1 }, 'USD', d))
      .rejects.toThrow(/pass cpc_bid/);
  });

  it('a foreign ad group is refused, nothing read or sent', async () => {
    const d = writeDeps();
    await expect(executeGoogleToolkitWrite('u1', { ...base, entity_type: 'AD_GROUP', action: 'UPDATE', ad_group_resource_name: FOREIGN_AD_GROUP, name: 'x' }, 'USD', d))
      .rejects.toThrow(/must be a adGroups resource name in customer|resource name in customer/);
    expect(d.read).not.toHaveBeenCalled();
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('a missing ad group is refused at preview', async () => {
    const d = writeDeps();
    await expect(executeGoogleToolkitWrite('u1', { ...base, entity_type: 'AD_GROUP', action: 'UPDATE', ad_group_resource_name: `customers/${CID}/adGroups/404`, name: 'x' }, 'USD', d))
      .rejects.toThrow(/not found/);
  });
});

describe('ENG-2959 shape rules', () => {
  it.each([
    ['CAMPAIGN', { campaign_resource_name: CAMPAIGN, status: 'PAUSED', name: 'x' }],
    ['AD_GROUP', { ad_group_resource_name: AD_GROUP, status: 'ENABLED', cpc_bid: 1 }],
    ['AD_GROUP', { ad_group_resource_name: AD_GROUP, status: 'PAUSED', name: 'x' }],
  ])('%s: status mixed with an edit is refused', async (entity, extra) => {
    const d = writeDeps();
    await expect(executeGoogleToolkitWrite('u1', { ...base, entity_type: entity, action: 'UPDATE', ...extra }, 'USD', d))
      .rejects.toThrow(/status must be sent alone/);
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['CAMPAIGN', { campaign_resource_name: CAMPAIGN, budget_resource_name: `customers/${CID}/campaignBudgets/1` }],
    ['CAMPAIGN', { campaign_resource_name: CAMPAIGN, bidding_strategy: 'MANUAL_CPC' }],
    ['CAMPAIGN', { campaign_resource_name: CAMPAIGN, location_target_ids: ['2840'] }],
    ['CAMPAIGN', { campaign_resource_name: CAMPAIGN, start_date: '2026-12-01' }],
    ['AD_GROUP', { ad_group_resource_name: AD_GROUP, target_cpa_micros: 1 }],
    ['AD_GROUP', { ad_group_resource_name: AD_GROUP, ad_rotation_mode: 'OPTIMIZE' }],
  ])('%s UPDATE: any other field is refused with a caller-visible error', async (entity, extra) => {
    const d = writeDeps();
    await expect(executeGoogleToolkitWrite('u1', { ...base, entity_type: entity, action: 'UPDATE', name: 'x', ...extra }, 'USD', d))
      .rejects.toBeInstanceOf(MetaToolkitRefusal);
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('an UPDATE with nothing to change, or a blank name, is refused', async () => {
    const d = writeDeps();
    await expect(executeGoogleToolkitWrite('u1', { ...base, entity_type: 'AD_GROUP', action: 'UPDATE', ad_group_resource_name: AD_GROUP }, 'USD', d))
      .rejects.toThrow(/requires status, name or cpc_bid/);
    await expect(executeGoogleToolkitWrite('u1', { ...base, entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_resource_name: CAMPAIGN, name: '  ' }, 'USD', d))
      .rejects.toThrow(/name must be a non-empty string/);
  });

  it('status-only UPDATE behaves as before', async () => {
    const d = writeDeps();
    const { preview, result } = await approve(d, { ...base, entity_type: 'AD_GROUP', action: 'UPDATE', ad_group_resource_name: AD_GROUP, status: 'PAUSED' });
    expect(preview.preview).toContain('Ad group "Shoes": ENABLED → PAUSED.');
    expect(result).toMatchObject({ success: true, verification: 'CONFIRMED', status: 'PAUSED' });
  });

  it('read mapping carries ad_group.cpc_bid_micros', () => {
    expect(mapGoogleReadRow('ad_group', { adGroup: { resourceName: AD_GROUP, name: 'n', status: 'ENABLED', cpcBidMicros: '1500000' } }))
      .toMatchObject({ cpcBidMicros: 1_500_000 });
  });

  it('advertised schema/description document the edits', () => {
    const tool = getGoogleToolkitManifest().find((t: any) => t.name === 'call_google_ads_api') as any;
    expect(tool.description).toContain('UPDATE (campaign_resource_name, status | name | target_search_network | target_content_network)');
    expect(tool.description).toContain('UPDATE (ad_group_resource_name, status | name? cpc_bid?)');
    expect(tool.inputSchema?.properties?.cpc_bid_micros ?? tool.input_schema?.properties?.cpc_bid_micros).toBeUndefined();
  });
});

describe('ENG-2959 key scope', () => {
  const prev = process.env.ZOMA_GOOGLE_ENABLED;
  beforeEach(() => { process.env.ZOMA_GOOGLE_ENABLED = 'true'; });
  afterAll(() => {
    if (prev === undefined) delete process.env.ZOMA_GOOGLE_ENABLED;
    else process.env.ZOMA_GOOGLE_ENABLED = prev;
  });

  it.each([
    ['CAMPAIGN rename', { entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_resource_name: CAMPAIGN, name: 'x' }],
    ['AD_GROUP cpc_bid', { entity_type: 'AD_GROUP', action: 'UPDATE', ad_group_resource_name: AD_GROUP, cpc_bid: 2 }],
  ])('a read-only aw_ key cannot run %s', async (_l, args) => {
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
    await expect(handleMetaToolkitCall({ authorization: 'Bearer aw_x', toolName: 'call_google_ads_api', args: { customer_id: CID, ...args } }, deps))
      .rejects.toMatchObject({ status: 403 });
    expect(deps.listAccounts).not.toHaveBeenCalled();
    expect(deps.recordWrite).not.toHaveBeenCalled();
  });
});
