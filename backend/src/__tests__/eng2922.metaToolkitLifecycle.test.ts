/**
 * ENG-2922 acceptance — guarded ARCHIVE / DELETE / COPY of Meta campaigns, ad sets, ads:
 *  - every change is preview → confirm with a single-use bound preview_token (nothing sent on preview);
 *  - ARCHIVE / DELETE are refused when the entity spent in the last 24h (or spend is unknown)
 *    unless confirm_recent_spend=true;
 *  - COPY uses status_option=PAUSED (deep_copy optional) and the copy must read back PAUSED;
 *  - read-back verification is CONFIRMED / MISMATCH / UNCONFIRMED;
 *  - the gateway enforces aw_ key scopes and meters an executed lifecycle write.
 */
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../mcp/zomaOnboarding', () => {
  const actual = jest.requireActual('../mcp/zomaOnboarding');
  return { ...actual, assertZomaWriteReady: jest.fn() };
});
jest.mock('../services/agentApiKeyService', () => ({ agentApiKeyService: { validateKey: jest.fn() } }));
jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: { validateAccessToken: jest.fn() } }));
jest.mock('../services/mcpUsageEventsService', () => ({ recordMcpToolUse: jest.fn(), recordMcpWriteExecuted: jest.fn() }));
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));

import { executeMetaToolkitLifecycle, type MetaToolkitLifecycleDeps } from '../mcp/metaToolkitLifecycle';
import { copyMetaNode, readMetaRecentSpend, readOwnedMetaNode, recentSpendWindow, type MetaGraphContext } from '../services/agentMode/metaToolkitLifecycleGraph';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';
import { ZomaNotReadyError } from '../mcp/zomaOnboarding';
import { handleMetaToolkitCall, type MetaToolkitGatewayDeps } from '../mcp/metaToolkitGateway';
import { getMetaToolkitManifest } from '../mcp/metaToolkitManifest';

const NOW = 1_800_000_000_000;
const account = (scopes: string[] = ['ads_read', 'ads_management']) => ({
  platform: 'meta', account_id: 'act_111',
  config: { account_type: 'ad_account', access_token: 'tok', ad_account_id: '111', granted_scopes: scopes },
});

function makeDeps(over: Partial<MetaToolkitLifecycleDeps> = {}) {
  const nodes: Record<string, any> = {
    '900': { id: '900', name: 'Spring', status: 'PAUSED', effective_status: 'PAUSED' },
    '901': { id: '901', name: 'Copy', status: 'PAUSED', effective_status: 'PAUSED' },
    '700': { id: '700', name: 'Other campaign', status: 'ACTIVE' },
  };
  const deps: MetaToolkitLifecycleDeps = {
    assertReady: jest.fn().mockResolvedValue(undefined),
    listAccounts: jest.fn().mockResolvedValue([account()]),
    readNode: jest.fn(async (_u, _a, _e, id) => (nodes[id] ? { ...nodes[id] } : null)),
    recentSpend: jest.fn().mockResolvedValue(0),
    archive: jest.fn(async (_u, _a, _e, id) => { nodes[id].status = 'ARCHIVED'; }),
    remove: jest.fn(async (_u, _a, _e, id) => { nodes[id].status = 'DELETED'; }),
    copy: jest.fn().mockResolvedValue({ copiedId: '901', childIds: ['902', '903'] }),
    secret: () => 'test-secret',
    now: () => NOW,
    consumedTokens: new Map(),
    ...over,
  };
  return { deps, nodes, mock: deps as unknown as Record<string, jest.Mock> };
}

const args = (action: string, extra: any = {}) => ({ entity_type: 'CAMPAIGN', action, account_id: '111', campaign_id: '900', ...extra });

async function previewThenConfirm(deps: MetaToolkitLifecycleDeps, a: any) {
  const preview: any = await executeMetaToolkitLifecycle('u1', a, deps);
  expect(preview.status).toBe('PREVIEW');
  return executeMetaToolkitLifecycle('u1', { ...a, confirm: true, preview_token: preview.preview_token }, deps);
}

describe('ENG-2922 Meta ARCHIVE / DELETE / COPY', () => {
  it.each(['ARCHIVE', 'DELETE', 'COPY'])('%s preview sends nothing; confirm without a token is refused', async (action) => {
    const { deps, mock } = makeDeps();
    const preview: any = await executeMetaToolkitLifecycle('u1', args(action), deps);
    expect(preview).toMatchObject({ status: 'PREVIEW', success: false });
    expect(typeof preview.preview_token).toBe('string');
    const noToken: any = await executeMetaToolkitLifecycle('u1', { ...args(action), confirm: true }, deps);
    expect(noToken.status).toBe('PREVIEW_MISMATCH');
    for (const fn of ['archive', 'remove', 'copy']) expect(mock[fn]).not.toHaveBeenCalled();
  });

  it('ARCHIVE confirms by read-back ARCHIVED; repeating it is NO_CHANGE', async () => {
    const { deps, mock } = makeDeps();
    const preview: any = await executeMetaToolkitLifecycle('u1', args('ARCHIVE'), deps);
    const confirm = { ...args('ARCHIVE'), confirm: true, preview_token: preview.preview_token };
    const res: any = await executeMetaToolkitLifecycle('u1', confirm, deps);
    expect(res).toMatchObject({ success: true, verification: 'CONFIRMED', id: '900', status: 'ARCHIVED' });
    expect(await executeMetaToolkitLifecycle('u1', confirm, deps)).toMatchObject({ status: 'NO_CHANGE' });
    expect(mock.archive).toHaveBeenCalledTimes(1);
  });

  it('a preview_token is single use and bound to the user', async () => {
    const { deps, mock } = makeDeps();
    const preview: any = await executeMetaToolkitLifecycle('u1', args('COPY'), deps);
    const confirm = { ...args('COPY'), confirm: true, preview_token: preview.preview_token };
    expect(await executeMetaToolkitLifecycle('u2', confirm, deps)).toMatchObject({ status: 'PREVIEW_MISMATCH' });
    await executeMetaToolkitLifecycle('u1', confirm, deps);
    await expect(executeMetaToolkitLifecycle('u1', confirm, deps)).rejects.toThrow(/already used/);
    expect(mock.copy).toHaveBeenCalledTimes(1);
  });

  it('DELETE warns it is irreversible and confirms when the node reads back DELETED or is gone', async () => {
    const { deps } = makeDeps();
    const preview: any = await executeMetaToolkitLifecycle('u1', args('DELETE'), deps);
    expect(preview.preview).toMatch(/cannot be undone/);
    const res: any = await executeMetaToolkitLifecycle('u1', { ...args('DELETE'), confirm: true, preview_token: preview.preview_token }, deps);
    expect(res).toMatchObject({ success: true, verification: 'CONFIRMED', status: 'DELETED' });

    const gone = makeDeps();
    (gone.mock.remove as jest.Mock).mockImplementation(async () => { delete gone.nodes['900']; });
    const res2: any = await previewThenConfirm(gone.deps, args('DELETE'));
    expect(res2).toMatchObject({ success: true, verification: 'CONFIRMED' });
  });

  it.each(['ARCHIVE', 'DELETE'])('%s is refused when the entity spent in the last 24h, unless confirm_recent_spend=true', async (action) => {
    const { deps, mock } = makeDeps({ recentSpend: jest.fn().mockResolvedValue(12.5) });
    await expect(executeMetaToolkitLifecycle('u1', args(action), deps)).rejects.toThrow(/spent 12\.50 .*last 24 hours/);
    const res: any = await previewThenConfirm(deps, args(action, { confirm_recent_spend: true }));
    expect(res.verification).toBe('CONFIRMED');
    expect(mock.recentSpend).toHaveBeenCalledWith('u1', '111', 'CAMPAIGN', '900');
  });

  it('unknown recent spend fails closed the same way', async () => {
    const { deps, mock } = makeDeps({ recentSpend: jest.fn().mockRejectedValue(new Error('insights down')) });
    await expect(executeMetaToolkitLifecycle('u1', args('ARCHIVE'), deps)).rejects.toThrow(/could not read the last 24 hours/);
    expect(mock.archive).not.toHaveBeenCalled();
  });

  it('a token minted without confirm_recent_spend does not confirm a call that adds it', async () => {
    const { deps, mock } = makeDeps();
    const preview: any = await executeMetaToolkitLifecycle('u1', args('ARCHIVE'), deps);
    const res: any = await executeMetaToolkitLifecycle('u1', { ...args('ARCHIVE', { confirm_recent_spend: true }), confirm: true, preview_token: preview.preview_token }, deps);
    expect(res.status).toBe('PREVIEW_MISMATCH');
    expect(mock.archive).not.toHaveBeenCalled();
  });

  it('confirm_recent_spend on an entity still spending confirms (the amount moving does not invalidate)', async () => {
    const spend = jest.fn().mockResolvedValueOnce(12.3).mockResolvedValue(12.47);
    const { deps, nodes } = makeDeps({ recentSpend: spend });
    nodes['900'].effective_status = 'ACTIVE';
    const preview: any = await executeMetaToolkitLifecycle('u1', args('ARCHIVE', { confirm_recent_spend: true }), deps);
    nodes['900'].effective_status = 'WITH_ISSUES';
    const res: any = await executeMetaToolkitLifecycle('u1', { ...args('ARCHIVE', { confirm_recent_spend: true }), confirm: true, preview_token: preview.preview_token }, deps);
    expect(res).toMatchObject({ verification: 'CONFIRMED' });
  });

  it('a DELETE that errors and then reads back as gone is UNCONFIRMED, not CONFIRMED', async () => {
    const { deps, nodes, mock } = makeDeps();
    let attempted = false;
    (mock.remove as jest.Mock).mockImplementation(async () => { attempted = true; throw Object.assign(new Error('Permissions error'), { response: { status: 400 } }); });
    // After the failed call the node is unreadable (e.g. access lost), which is not proof of deletion.
    (mock.readNode as jest.Mock).mockImplementation(async (_u: string, _a: string, _e: string, id: string) => (attempted ? null : nodes[id] ? { ...nodes[id] } : null));
    const preview: any = await executeMetaToolkitLifecycle('u1', args('DELETE'), deps);
    const res: any = await executeMetaToolkitLifecycle('u1', { ...args('DELETE'), confirm: true, preview_token: preview.preview_token }, deps);
    expect(res).toMatchObject({ success: false, verification: 'UNCONFIRMED' });
  });

  it('spend appearing between preview and confirm invalidates the approval', async () => {
    const spend = jest.fn().mockResolvedValue(0);
    const { deps, mock } = makeDeps({ recentSpend: spend });
    const preview: any = await executeMetaToolkitLifecycle('u1', args('ARCHIVE', { confirm_recent_spend: true }), deps);
    spend.mockResolvedValue(3);
    const res: any = await executeMetaToolkitLifecycle('u1', { ...args('ARCHIVE', { confirm_recent_spend: true }), confirm: true, preview_token: preview.preview_token }, deps);
    expect(res.status).toBe('PREVIEW_MISMATCH');
    expect(mock.archive).not.toHaveBeenCalled();
  });

  it('COPY is created PAUSED with deep_copy, does not check spend, and verifies the copy reads back PAUSED', async () => {
    const { deps, mock } = makeDeps();
    const res: any = await previewThenConfirm(deps, args('COPY', { params: { deep_copy: true } }));
    expect(mock.copy).toHaveBeenCalledWith('u1', '111', 'CAMPAIGN', '900', expect.objectContaining({ deep_copy: true }));
    expect(mock.recentSpend).not.toHaveBeenCalled();
    expect(res).toMatchObject({ success: true, verification: 'CONFIRMED', id: '901', source_id: '900', child_ids: ['902', '903'], status: 'PAUSED' });
  });

  it('COPY whose copy reads back ACTIVE is MISMATCH; an unreadable copy is UNCONFIRMED', async () => {
    const active = makeDeps();
    active.nodes['901'].status = 'ACTIVE';
    expect(await previewThenConfirm(active.deps, args('COPY'))).toMatchObject({ success: false, verification: 'MISMATCH' });

    const unreadable = makeDeps();
    (unreadable.mock.readNode as jest.Mock).mockImplementation(async (_u: string, _a: string, _e: string, id: string) => {
      if (id === '901') throw new Error('timeout');
      return unreadable.nodes[id] ?? null;
    });
    expect(await previewThenConfirm(unreadable.deps, args('COPY'))).toMatchObject({ success: false, verification: 'UNCONFIRMED' });
  });

  it('COPY refused by Meta with no new id is FAILED (not metered); a network error is UNCONFIRMED', async () => {
    const refused = makeDeps({ copy: jest.fn().mockRejectedValue(Object.assign(new Error('too many children'), { response: { status: 400 } })) });
    const r1: any = await previewThenConfirm(refused.deps, args('COPY', { params: { deep_copy: true } }));
    expect(r1).toMatchObject({ status: 'FAILED', success: false });
    expect(r1.verification).toBeUndefined();

    const timeout = makeDeps({ copy: jest.fn().mockRejectedValue(new Error('socket hang up')) });
    expect(await previewThenConfirm(timeout.deps, args('COPY'))).toMatchObject({ success: false, verification: 'UNCONFIRMED' });
  });

  it('ARCHIVE that Meta refuses and the read-back shows unchanged is FAILED', async () => {
    const { deps } = makeDeps({ archive: jest.fn().mockRejectedValue(new Error('permission')) });
    expect(await previewThenConfirm(deps, args('ARCHIVE'))).toMatchObject({ status: 'FAILED', success: false });
  });

  it('AD_SET COPY takes a top-level campaign_id as the destination campaign instead of dropping it (Zoma/Haven)', async () => {
    const { deps, mock } = makeDeps();
    const a = { entity_type: 'AD_SET', action: 'COPY', account_id: '111', ad_set_id: '900', campaign_id: '700', params: { deep_copy: true } };
    const preview: any = await executeMetaToolkitLifecycle('u1', a, deps);
    expect(preview.preview).toMatch(/into campaign "Other campaign" \(id 700\)/);
    await executeMetaToolkitLifecycle('u1', { ...a, confirm: true, preview_token: preview.preview_token }, deps);
    expect(mock.copy).toHaveBeenCalledWith('u1', '111', 'AD_SET', '900', expect.objectContaining({ campaign_id: '700', deep_copy: true }));
  });

  it('a Meta refusal of a COPY is reported with Meta\'s reason', async () => {
    const refused = makeDeps({ copy: jest.fn().mockRejectedValue(Object.assign(new Error('Invalid parameter — Ad set budget not allowed (code 100, subcode 1885621)'), { response: { status: 400 } })) });
    const r: any = await previewThenConfirm(refused.deps, { entity_type: 'AD_SET', action: 'COPY', account_id: '111', ad_set_id: '900', params: { campaign_id: '700' } });
    expect(r).toMatchObject({ status: 'FAILED', success: false });
    expect(r.message).toContain('subcode 1885621');
  });

  it('COPY refuses status_option other than PAUSED and a destination outside the ad account', async () => {
    const { deps, mock } = makeDeps();
    await expect(executeMetaToolkitLifecycle('u1', args('COPY', { params: { status_option: 'ACTIVE' } }), deps)).rejects.toThrow(/always created PAUSED/);
    const adSetCopy = { entity_type: 'AD_SET', action: 'COPY', account_id: '111', ad_set_id: '900', params: { campaign_id: '555' } };
    await expect(executeMetaToolkitLifecycle('u1', adSetCopy, deps)).rejects.toThrow(/destination CAMPAIGN 555 was not found/);
    const ok: any = await executeMetaToolkitLifecycle('u1', { ...adSetCopy, params: { campaign_id: '700' } }, deps);
    expect(ok.preview).toContain('Other campaign');
    expect(mock.copy).not.toHaveBeenCalled();
  });

  it('refuses unknown params, missing ids, foreign nodes, missing ads_management and no payment method', async () => {
    const { deps, mock } = makeDeps();
    await expect(executeMetaToolkitLifecycle('u1', args('ARCHIVE', { params: { status: 'ACTIVE' } }), deps)).rejects.toThrow(/accepts no params/);
    await expect(executeMetaToolkitLifecycle('u1', { entity_type: 'AD', action: 'DELETE', account_id: '111' }, deps)).rejects.toThrow(/requires ad_id/);
    await expect(executeMetaToolkitLifecycle('u1', args('ARCHIVE', { campaign_id: '404' }), deps)).rejects.toThrow(/was not found in ad account 111/);
    await expect(executeMetaToolkitLifecycle('u1', args('ARCHIVE', { client_id: 'x' }), deps)).rejects.toBeInstanceOf(MetaToolkitRefusal);

    const noScope = makeDeps({ listAccounts: jest.fn().mockResolvedValue([account(['ads_read'])]) });
    await expect(executeMetaToolkitLifecycle('u1', args('DELETE'), noScope.deps)).rejects.toThrow(/ads_management/);
    const noPay = makeDeps({ assertReady: jest.fn().mockRejectedValue(new ZomaNotReadyError('No payment method on file')) });
    await expect(executeMetaToolkitLifecycle('u1', args('DELETE'), noPay.deps)).rejects.toThrow(/No payment method/);
    expect(mock.remove).not.toHaveBeenCalled();
  });

  it('already archived / deleted is NO_CHANGE without a token; a deleted entity cannot be copied', async () => {
    const { deps, nodes, mock } = makeDeps();
    nodes['900'].status = 'ARCHIVED';
    expect(await executeMetaToolkitLifecycle('u1', args('ARCHIVE'), deps)).toMatchObject({ status: 'NO_CHANGE' });
    nodes['900'].status = 'DELETED';
    await expect(executeMetaToolkitLifecycle('u1', args('COPY'), deps)).rejects.toThrow(/deleted and cannot be copied/);
    expect(mock.archive).not.toHaveBeenCalled();
  });
});

describe('ENG-2922 Graph seam', () => {
  const ctx = (get: jest.Mock, post: jest.Mock = jest.fn()): MetaGraphContext => ({ http: { get, post }, accountId: '111', accessToken: 'tok', apiVersion: 'v25.0' });

  it('readOwnedMetaNode treats a node from another ad account, or a missing node, as absent', async () => {
    expect(await readOwnedMetaNode(ctx(jest.fn().mockResolvedValue({ data: { id: '9', status: 'PAUSED', account_id: '222' } })), '9')).toBeNull();
    expect(await readOwnedMetaNode(ctx(jest.fn().mockResolvedValue({ data: { id: '9', status: 'PAUSED', account_id: '111' } })), '9')).toMatchObject({ id: '9', status: 'PAUSED' });
    const missing = jest.fn().mockRejectedValue({ response: { data: { error: { code: 100, error_subcode: 33, message: 'does not exist' } } } });
    expect(await readOwnedMetaNode(ctx(missing), '9')).toBeNull();
    await expect(readOwnedMetaNode(ctx(jest.fn().mockRejectedValue(new Error('500'))), '9')).rejects.toThrow('500');
  });

  it('readMetaRecentSpend sums spend over a window covering the account\'s local today and yesterday in any timezone', async () => {
    const get = jest.fn().mockResolvedValue({ data: { data: [{ spend: '1.25' }, { spend: '2' }] } });
    expect(await readMetaRecentSpend(ctx(get), '9', Date.parse('2026-11-10T05:00:00Z'))).toBeCloseTo(3.25);
    expect(JSON.parse(get.mock.calls[0][1].params.time_range)).toEqual({ since: '2026-11-08', until: '2026-11-11' });
    // UTC+14 at 20:00Z on 11-10 is local 11-11 10:00 (today) and 11-10 (yesterday); UTC-12 is local 11-10 08:00 and 11-09.
    for (const [offsetH, today, yesterday] of [[14, '2026-11-11', '2026-11-10'], [-12, '2026-11-10', '2026-11-09'], [10, '2026-11-11', '2026-11-10']] as const) {
      const now = Date.parse('2026-11-10T20:00:00Z');
      const w = recentSpendWindow(now);
      const local = (ms: number) => new Date(ms + offsetH * 3600_000).toISOString().slice(0, 10);
      expect(local(now)).toBe(today);
      expect(local(now - 86_400_000)).toBe(yesterday);
      for (const d of [today, yesterday]) expect(d >= w.since && d <= w.until).toBe(true);
    }
    await expect(readMetaRecentSpend(ctx(jest.fn().mockResolvedValue({ data: {} })), '9', NOW)).rejects.toThrow();
  });

  it('copyMetaNode posts /copies with status_option=PAUSED and returns the copied ids', async () => {
    const post = jest.fn().mockResolvedValue({ data: { copied_campaign_id: '5', ad_object_ids: [{ copied_ids: ['6', '7'] }] } });
    expect(await copyMetaNode(ctx(jest.fn(), post), 'CAMPAIGN', '9', { deep_copy: true })).toEqual({ copiedId: '5', childIds: ['6', '7'] });
    expect(post.mock.calls[0][0]).toBe('https://graph.facebook.com/v25.0/9/copies');
    expect(post.mock.calls[0][2].params).toMatchObject({ status_option: 'PAUSED', deep_copy: true });
    const adPost = jest.fn().mockResolvedValue({ data: { copied_ad_id: '8' } });
    await copyMetaNode(ctx(jest.fn(), adPost), 'AD', '9', { adset_id: '44', deep_copy: true });
    expect(adPost.mock.calls[0][2].params).toEqual({ status_option: 'PAUSED', adset_id: '44', access_token: 'tok' });
  });

  it('copyMetaNode surfaces Meta\'s error detail on a 400, not axios\'s bare "status code 400" (Zoma/Haven)', async () => {
    const axios400: any = Object.assign(new Error('Request failed with status code 400'), {
      response: {
        status: 400,
        data: { error: { message: 'Invalid parameter', code: 100, error_subcode: 1885621, error_user_title: 'Ad set budget not allowed', error_user_msg: 'This campaign uses a campaign budget.', fbtrace_id: 'TR1' } },
        config: { params: { access_token: 'tok' } },
      },
    });
    const post = jest.fn().mockRejectedValue(axios400);
    const err: any = await copyMetaNode(ctx(jest.fn(), post), 'AD_SET', '9', { campaign_id: '44', deep_copy: true }).catch((e: any) => e);
    for (const part of ['Invalid parameter', 'Ad set budget not allowed', 'campaign budget', 'code 100', 'subcode 1885621', 'fbtrace_id TR1']) {
      expect(err.message).toContain(part);
    }
    expect(err.message).not.toContain('status code 400');
    expect(err.response.status).toBe(400);
    expect(JSON.stringify(err.response)).not.toContain('tok');
    expect(post.mock.calls[0][2].params).toMatchObject({ status_option: 'PAUSED', campaign_id: '44', deep_copy: true });
  });
});

describe('ENG-2922 gateway + manifest', () => {
  const accounts = [{ platform: 'meta', account_id: '123', config: { account_type: 'ad_account', ad_account_id: '123', access_token: 'x' } }];
  function gw(scopes: string[] | undefined, result: any = { verification: 'CONFIRMED', id: '900' }) {
    const raw = {
      validateApiKey: jest.fn().mockResolvedValue({ userId: 'u1', keyId: 'k1', ...(scopes ? { scopes } : {}) }),
      validateOAuthToken: jest.fn(),
      listAccounts: jest.fn().mockResolvedValue(accounts),
      execute: jest.fn(),
      recordUsage: jest.fn().mockResolvedValue(undefined),
      recordWrite: jest.fn().mockResolvedValue(undefined),
      now: () => Date.parse('2026-11-10T00:00:00Z'),
      rateLimiter: { check: () => ({ allowed: true, remaining: 1, resetInMs: 0 }) },
      executeWrite: jest.fn(),
      executeLifecycle: jest.fn().mockResolvedValue(result),
    };
    return { raw, deps: raw as unknown as MetaToolkitGatewayDeps };
  }
  const call = { authorization: 'Bearer aw_fixture', toolName: 'call_meta_marketing_api', args: { entity_type: 'CAMPAIGN', action: 'ARCHIVE', campaign_id: '900', account_id: '123' } };

  it('a read-only aw_ key is denied 403 before the lifecycle executor runs', async () => {
    const { raw, deps } = gw(['tools:read']);
    await expect(handleMetaToolkitCall(call, deps)).rejects.toMatchObject({ status: 403 });
    expect(raw.executeLifecycle).not.toHaveBeenCalled();
    expect(raw.recordUsage).not.toHaveBeenCalled();
  });

  it('an executed lifecycle write is metered as a write with its verification; a preview is not', async () => {
    const { raw, deps } = gw(['tools:read', 'tools:execute']);
    await handleMetaToolkitCall(call, deps);
    expect(raw.executeLifecycle).toHaveBeenCalledWith('u1', expect.objectContaining({ action: 'ARCHIVE', account_id: '123' }));
    expect(raw.executeWrite).not.toHaveBeenCalled();
    expect(raw.recordWrite).toHaveBeenCalledWith(expect.objectContaining({ platform: 'meta', entityType: 'CAMPAIGN', action: 'ARCHIVE', verification: 'CONFIRMED', objectId: '900' }));

    const preview = gw(undefined, { status: 'PREVIEW', preview_token: 't' });
    await handleMetaToolkitCall({ ...call, args: { ...call.args, action: 'COPY' } }, preview.deps);
    expect(preview.raw.recordWrite).not.toHaveBeenCalled();
    expect(preview.raw.recordUsage).toHaveBeenCalledTimes(1);
  });

  it('the manifest advertises ARCHIVE / DELETE / COPY and confirm_recent_spend', () => {
    const mkt: any = getMetaToolkitManifest().find((d: any) => d.name === 'call_meta_marketing_api');
    expect(mkt.inputSchema.properties.action.enum).toEqual(expect.arrayContaining(['ARCHIVE', 'DELETE', 'COPY']));
    expect(mkt.inputSchema.properties.confirm_recent_spend.type).toBe('boolean');
    expect(mkt.description).toMatch(/confirm_recent_spend/);
  });
});
