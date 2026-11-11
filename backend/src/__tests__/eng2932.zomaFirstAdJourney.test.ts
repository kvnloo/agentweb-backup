/**
 * ENG-2932 (child of ENG-2883): Zoma first-ad journey, end to end against a mocked Meta Graph.
 *
 * Drives a freshly created org through the guarded Meta Toolkit write path the way an agent
 * does: (not connected -> refused) -> Meta connect -> campaign / ad set / ad CREATE (PAUSED)
 * -> launch (ACTIVE, each its own preview + approval). No network: the Graph is an in-memory
 * fake shared by dispatch + read-back, so what is reported must match what "Meta" holds.
 *
 * Cases (ENG-2932 acceptance):
 *  1. happy path -> every step CONFIRMED with the created ids, launch reports ACTIVE;
 *  2. Meta rejects ad creation -> FAILED with Meta's message, nothing reported launched;
 *  3. ad created but enabling it fails -> launch reported FAILED, ad still PAUSED in Meta.
 */
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../mcp/zomaOnboarding', () => {
  const actual = jest.requireActual('../mcp/zomaOnboarding');
  return { ...actual, assertZomaWriteReady: jest.fn() };
});

import { executeMetaToolkitWrite, type MetaToolkitWriteDeps } from '../mcp/metaToolkitWrites';
import { normalizeMetaMoney } from '../services/metaService';

const USER = 'fresh-user-1';
const ACCOUNT = '111';
const NOW = 1_800_000_000_000;

type Entity = 'CAMPAIGN' | 'AD_SET' | 'AD';
interface GraphObject { id: string; entity: Entity; status: string; effective_status: string; [k: string]: any }

/** In-memory Meta Graph: the single source both dispatch and read-back see. */
class FakeGraph {
  objects = new Map<string, GraphObject>();
  calls: Array<{ entity: string; action: string; id?: string }> = [];
  private seq = 1000;
  rejectCreate = new Map<Entity, string>();
  rejectActivate = new Map<Entity, string>();

  dispatch = async (_u: string, d: any): Promise<{ result: any; createdId?: string }> => {
    const entity = d.entity_type as Entity;
    const params = d.params ?? {};
    if (d.action === 'CREATE') {
      this.calls.push({ entity, action: 'CREATE' });
      const err = this.rejectCreate.get(entity);
      if (err) return { result: { success: false, error: err } };
      const id = String(++this.seq);
      const minor: any = {};
      for (const f of ['daily_budget', 'lifetime_budget']) if (params[f] !== undefined) minor[f] = String(normalizeMetaMoney(params[f], 'USD').minorUnits); // writer converts major -> minor
      this.objects.set(id, {
        id, entity, name: params.name, status: params.status, effective_status: params.status,
        campaign_id: d.campaign_id, adset_id: d.ad_set_id, creative_id: params.creative_id, ...minor,
      });
      return { result: { success: true, message: `${entity} created successfully` }, createdId: id };
    }
    const id = String(entity === 'CAMPAIGN' ? d.campaign_id : entity === 'AD_SET' ? d.ad_set_id : d.ad_id);
    this.calls.push({ entity, action: 'UPDATE', id });
    const obj = this.objects.get(id);
    if (!obj) return { result: { success: false, error: `Unsupported request: object ${id} does not exist` } };
    if (params.status === 'ACTIVE') {
      const err = this.rejectActivate.get(entity);
      if (err) return { result: { success: false, error: err } };
    }
    Object.assign(obj, params);
    if (params.status) obj.effective_status = params.status;
    return { result: { success: true, message: `${entity} updated` } };
  };

  readBack = async (_u: string, _a: string, _e: string, id: string) => {
    const obj = this.objects.get(id);
    return obj ? { ...obj } : null;
  };
}

function makeDeps(graph: FakeGraph, connected: { value: boolean }): MetaToolkitWriteDeps {
  return {
    assertReady: jest.fn().mockResolvedValue(undefined),
    listAccounts: jest.fn(async () => (connected.value ? [{
      platform: 'meta', account_id: `act_${ACCOUNT}`,
      config: { account_type: 'ad_account', access_token: 'tok', ad_account_id: ACCOUNT, granted_scopes: ['ads_read', 'ads_management'] },
    }] : []) as any),
    previewMoney: jest.fn(async (_u: string, _a: string, params: any) => {
      const out = { ...params };
      for (const f of ['daily_budget', 'lifetime_budget']) {
        if (params[f] !== undefined) out[f] = normalizeMetaMoney(params[f], 'USD').minorUnits;
      }
      return { params: out, currency: 'USD', confirmation: '' };
    }),
    preview: jest.fn(async (_u: string, entity: string, action: string, accountId: string, c?: string, as?: string, ad?: string, params?: any) => ({
      success: true,
      awaitingUserConfirmation: true,
      summary: `${action} ${entity} on ${accountId}`,
      metaWriteDispatch: { entity_type: entity, action, account_id: accountId, campaign_id: c, ad_set_id: as, ad_id: ad, params },
    })),
    dispatch: graph.dispatch,
    readBack: graph.readBack,
    assertCreativeOwned: jest.fn().mockResolvedValue(undefined),
    spendCeilingPolicy: () => null,
    secret: () => 'test-secret',
    now: () => NOW,
    consumedTokens: new Map(),
  };
}

/** One agent step: preview, (user approves), confirm with the preview token. */
async function approve(deps: MetaToolkitWriteDeps, args: any): Promise<any> {
  const preview: any = await executeMetaToolkitWrite(USER, args, deps);
  expect(preview.status).toBe('PREVIEW');
  expect(preview.preview).toContain('nothing has changed yet');
  return executeMetaToolkitWrite(USER, { ...args, confirm: true, preview_token: preview.preview_token }, deps);
}

const campaignArgs = { entity_type: 'CAMPAIGN', action: 'CREATE', account_id: ACCOUNT, params: { name: 'First ad', objective: 'OUTCOME_TRAFFIC', daily_budget: 20 } };
const adSetArgs = (campaignId: string) => ({
  entity_type: 'AD_SET', action: 'CREATE', account_id: ACCOUNT, campaign_id: campaignId,
  params: { name: 'First ad set', optimization_goal: 'LINK_CLICKS', billing_event: 'IMPRESSIONS', targeting: { geo_locations: { countries: ['US'] } } },
});
const adArgs = (campaignId: string, adSetId: string) => ({
  entity_type: 'AD', action: 'CREATE', account_id: ACCOUNT, campaign_id: campaignId, ad_set_id: adSetId,
  params: { name: 'First ad', creative_id: '777' },
});
const activate = (entity: Entity, ids: { campaign: string; adSet?: string; ad?: string }) => ({
  entity_type: entity, action: 'UPDATE', account_id: ACCOUNT, campaign_id: ids.campaign,
  ...(ids.adSet ? { ad_set_id: ids.adSet } : {}), ...(entity === 'AD' ? { ad_id: ids.ad } : {}),
  params: { status: 'ACTIVE' },
});

/** Fresh org: refused until Meta is connected, then connect. */
async function freshConnectedOrg() {
  const graph = new FakeGraph();
  const connected = { value: false };
  const deps = makeDeps(graph, connected);
  await expect(executeMetaToolkitWrite(USER, campaignArgs, deps)).rejects.toThrow(/Reconnect Meta/);
  expect(graph.calls).toHaveLength(0);
  connected.value = true; // OAuth connect completes, ads_management granted
  return { graph, deps };
}

async function createPausedAd(deps: MetaToolkitWriteDeps) {
  const campaign = await approve(deps, campaignArgs);
  expect(campaign).toMatchObject({ success: true, verification: 'CONFIRMED', status: 'PAUSED' });
  const adSet = await approve(deps, adSetArgs(campaign.id));
  expect(adSet).toMatchObject({ success: true, verification: 'CONFIRMED', status: 'PAUSED' });
  const ad = await approve(deps, adArgs(campaign.id, adSet.id));
  return { campaign, adSet, ad };
}

describe('ENG-2932 Zoma first-ad journey (mocked Meta Graph)', () => {
  it('1. fresh account -> connect -> create -> launch reports success with the created ids', async () => {
    const { graph, deps } = await freshConnectedOrg();
    const { campaign, adSet, ad } = await createPausedAd(deps);
    expect(ad).toMatchObject({ success: true, verification: 'CONFIRMED', status: 'PAUSED' });
    expect(new Set([campaign.id, adSet.id, ad.id]).size).toBe(3);

    const ids = { campaign: campaign.id, adSet: adSet.id, ad: ad.id };
    for (const entity of ['AD', 'AD_SET', 'CAMPAIGN'] as const) {
      const res = await approve(deps, activate(entity, ids));
      expect(res).toMatchObject({ success: true, verification: 'CONFIRMED', status: 'ACTIVE', effective_status: 'ACTIVE' });
      expect(res.message).toBe(`UPDATE ${entity} confirmed by read-back: id ${res.id}, status ACTIVE (effective ACTIVE).`);
    }
    expect([...graph.objects.values()].map((o) => o.status)).toEqual(['ACTIVE', 'ACTIVE', 'ACTIVE']);
    expect(graph.objects.get(campaign.id)!.daily_budget).toBe('2000');
  });

  it('2. Meta rejects ad creation -> exact failure surfaced, nothing created or launched', async () => {
    const { graph, deps } = await freshConnectedOrg();
    const metaError = 'Invalid parameter: The creative is not approved for this ad account.';
    graph.rejectCreate.set('AD', metaError);
    const { ad } = await createPausedAd(deps);
    expect(ad).toEqual({ status: 'FAILED', success: false, message: metaError });
    expect(ad.id).toBeUndefined();
    expect([...graph.objects.values()].filter((o) => o.entity === 'AD')).toHaveLength(0);
    expect([...graph.objects.values()].every((o) => o.status === 'PAUSED')).toBe(true);
    expect(graph.calls.some((c) => c.action === 'UPDATE')).toBe(false);
  });

  it('3. ad created but enabling it fails -> launch reported FAILED, ad stays PAUSED', async () => {
    const { graph, deps } = await freshConnectedOrg();
    const metaError = 'Ad is pending review and cannot be activated yet.';
    graph.rejectActivate.set('AD', metaError);
    const { campaign, adSet, ad } = await createPausedAd(deps);
    expect(ad).toMatchObject({ success: true, verification: 'CONFIRMED', status: 'PAUSED' });

    const launch = await approve(deps, activate('AD', { campaign: campaign.id, adSet: adSet.id, ad: ad.id }));
    expect(launch).toEqual({ status: 'FAILED', success: false, message: metaError });
    expect(graph.objects.get(ad.id)!.status).toBe('PAUSED');
    expect(graph.objects.get(ad.id)!.effective_status).toBe('PAUSED');
  });

  it('3b. Meta accepts the enable but the ad is not ACTIVE on read-back -> MISMATCH, never success', async () => {
    const { graph, deps } = await freshConnectedOrg();
    const { campaign, adSet, ad } = await createPausedAd(deps);
    const realDispatch = graph.dispatch;
    (deps as any).dispatch = async (u: string, d: any) => {
      if (d.entity_type === 'AD' && d.params?.status === 'ACTIVE') return { result: { success: true, message: 'ok' } }; // silently not applied
      return realDispatch(u, d);
    };
    const launch = await approve(deps, activate('AD', { campaign: campaign.id, adSet: adSet.id, ad: ad.id }));
    expect(launch).toMatchObject({ success: false, verification: 'MISMATCH', status: 'PAUSED' });
    expect(launch.message).toBe(`Meta accepted the UPDATE, but the read-back does not match what was approved. Review AD ${ad.id} before doing anything else.`);
  });
});
