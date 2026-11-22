// ENG-2927: Zoma catalog event sources (mocked Graph; no network, no storage).
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

import { handleMetaToolkitCall, MetaToolkitGatewayDeps } from '../mcp/metaToolkitGateway';
import { runMetaEventSourceTool, isMetaEventSourceWrite, MetaEventSourceDeps } from '../mcp/metaToolkitEventSources';
import { getMetaToolkitManifest } from '../mcp/metaToolkitManifest';

const NOW = Date.parse('2026-11-11T12:00:00Z');

function graph(overrides: Record<string, any> = {}) {
  const nodes: Record<string, any> = {
    act_111: { business: { id: '900' } },
    '900/owned_product_catalogs': { data: [{ id: '501', name: 'Main' }, { id: '502', name: 'Second' }] },
    '900/client_product_catalogs': { data: [] },
    'act_111/adspixels': { data: [
      { id: '41', name: 'Live', last_fired_time: '2026-11-11T10:00:00Z' },
      { id: '42', name: 'Stale', last_fired_time: '2026-11-01T10:00:00Z' },
    ] },
    '501/external_event_sources': { data: [{ id: '41', name: 'Live' }] },
    '502/external_event_sources': { data: [] },
    '501/diagnostics': { data: [{ type: 'EVENT_SOURCE_LOW_MATCH_RATE', severity: 'MUST_FIX', title: 'Low match rate' }, { type: 'PRICE', title: 'x' }] },
    '502/diagnostics': { data: [] },
    ...overrides,
  };
  const writes: Array<{ method: string; path: string; params: Record<string, string> }> = [];
  const readGraph = jest.fn(async (_u: string, _a: string, path: string) => {
    const r = nodes[path];
    if (r === undefined) throw Object.assign(new Error('not found'), { metaError: { code: 100, message: 'not found' } });
    return r;
  });
  const writeGraph = jest.fn(async (_u: string, _a: string, method: 'POST' | 'DELETE', path: string, params: Record<string, string>) => {
    writes.push({ method, path, params });
    const [ids] = [JSON.parse(params.external_event_sources)];
    const cur = nodes[path].data as any[];
    nodes[path] = { data: method === 'POST' ? [...cur, ...ids.map((id: string) => ({ id }))] : cur.filter((s) => !ids.includes(s.id)) };
    return { success: true };
  });
  const deps: MetaEventSourceDeps = { readGraph, writeGraph, secret: () => 's', now: () => NOW, consumedTokens: new Map(), tokenOutcomes: new Map() };
  return { deps, nodes, writes };
}

describe('ENG-2927 event sources', () => {
  it('advertises six tools; only connect/disconnect are writes', () => {
    const names = getMetaToolkitManifest().map((d: any) => d.name);
    for (const n of ['meta_event_source_get', 'meta_event_source_get_catalogs', 'meta_event_source_get_health', 'meta_event_source_get_recommendations', 'meta_event_source_connect', 'meta_event_source_disconnect']) {
      expect(names).toContain(n);
    }
    expect(isMetaEventSourceWrite('meta_event_source_get_health')).toBe(false);
    expect(isMetaEventSourceWrite('meta_event_source_connect')).toBe(true);
    expect(isMetaEventSourceWrite('meta_event_source_disconnect')).toBe(true);
  });

  it('reads a catalog\'s sources, a pixel\'s catalogs, health and recommendations', async () => {
    const g = graph();
    expect(await runMetaEventSourceTool('meta_event_source_get', 'u', '111', { catalog_id: '501' }, g.deps)).toMatchObject({ event_sources: [{ id: '41' }] });
    expect(await runMetaEventSourceTool('meta_event_source_get_catalogs', 'u', '111', { pixel_id: '41' }, g.deps)).toMatchObject({ catalogs: [{ catalog_id: '501' }] });
    expect(await runMetaEventSourceTool('meta_event_source_get_health', 'u', '111', { pixel_id: '41' }, g.deps)).toMatchObject({ state: 'ACTIVE', healthy: true });
    expect(await runMetaEventSourceTool('meta_event_source_get_health', 'u', '111', { pixel_id: '42' }, g.deps)).toMatchObject({ state: 'NOT_FIRING', healthy: false });
    const rec: any = await runMetaEventSourceTool('meta_event_source_get_recommendations', 'u', '111', { catalog_id: '501' }, g.deps);
    expect(rec.recommendations.map((r: any) => r.type)).toEqual(['EVENT_SOURCE_LOW_MATCH_RATE']);
    const none: any = await runMetaEventSourceTool('meta_event_source_get_recommendations', 'u', '111', { catalog_id: '502' }, g.deps);
    expect(none.recommendations[0]).toMatchObject({ type: 'NO_EVENT_SOURCE', message: expect.stringContaining('41') });
    expect(g.writes).toEqual([]);
  });

  it('rejects a cross-account pixel and a foreign catalog without writing', async () => {
    const g = graph();
    await expect(runMetaEventSourceTool('meta_event_source_connect', 'u', '111', { catalog_id: '502', pixel_id: '99' }, g.deps)).rejects.toThrow(/not a pixel of this ad account/);
    await expect(runMetaEventSourceTool('meta_event_source_get_health', 'u', '111', { pixel_id: '99' }, g.deps)).rejects.toThrow(/not a pixel of this ad account/);
    await expect(runMetaEventSourceTool('meta_event_source_connect', 'u', '111', { catalog_id: '777', pixel_id: '41' }, g.deps)).rejects.toThrow(/not available/);
    expect(g.writes).toEqual([]);
  });

  it('connect: preview first, confirm with token, verified by read-back; token is single use', async () => {
    const g = graph();
    const preview: any = await runMetaEventSourceTool('meta_event_source_connect', 'u', '111', { catalog_id: '502', pixel_id: '41' }, g.deps);
    expect(preview.status).toBe('PREVIEW');
    expect(g.writes).toEqual([]);
    await expect(runMetaEventSourceTool('meta_event_source_connect', 'u', '111', { catalog_id: '502', pixel_id: '41', confirm: true }, g.deps))
      .resolves.toMatchObject({ status: 'PREVIEW_MISMATCH' });
    const done: any = await runMetaEventSourceTool('meta_event_source_connect', 'u', '111', { catalog_id: '502', pixel_id: '41', confirm: true, preview_token: preview.preview_token }, g.deps);
    expect(done).toMatchObject({ success: true, verification: 'CONFIRMED' });
    expect(g.writes).toEqual([{ method: 'POST', path: '502/external_event_sources', params: { external_event_sources: '["41"]' } }]);
    // a repeat after success is a no-op, never a second write
    const replay: any = await runMetaEventSourceTool('meta_event_source_connect', 'u', '111', { catalog_id: '502', pixel_id: '41' }, g.deps);
    expect(replay.status).toBe('NO_CHANGE');
    expect(g.writes).toHaveLength(1);
  });

  it('disconnect reports MISMATCH when Meta accepts but the pixel is still connected', async () => {
    const g = graph();
    g.deps.writeGraph = jest.fn().mockResolvedValue({ success: true });
    const preview: any = await runMetaEventSourceTool('meta_event_source_disconnect', 'u', '111', { catalog_id: '501', pixel_id: '41' }, g.deps);
    const out: any = await runMetaEventSourceTool('meta_event_source_disconnect', 'u', '111', { catalog_id: '501', pixel_id: '41', confirm: true, preview_token: preview.preview_token }, g.deps);
    expect(out).toMatchObject({ success: false, verification: 'MISMATCH' });
  });
});

describe('ENG-2927 gateway: scope + metering', () => {
  const accounts = [{ platform: 'meta', account_id: '111', config: { account_type: 'ad_account', ad_account_id: '111', access_token: 'x' } }];
  function gateway(scopes: string[]) {
    const raw = {
      validateApiKey: jest.fn().mockResolvedValue({ userId: 'u1', keyId: 'k1', scopes }),
      validateOAuthToken: jest.fn(),
      listAccounts: jest.fn().mockResolvedValue(accounts),
      execute: jest.fn(),
      recordUsage: jest.fn().mockResolvedValue(undefined),
      recordWrite: jest.fn().mockResolvedValue(undefined),
      now: () => NOW,
      rateLimiter: { check: () => ({ allowed: true, remaining: 1, resetInMs: 0 }) },
      runEventSourceTool: jest.fn().mockResolvedValue({ success: true, verification: 'CONFIRMED', id: '41' }),
    };
    return { raw, deps: raw as unknown as MetaToolkitGatewayDeps };
  }

  it('read-only key is rejected on connect before any Meta call', async () => {
    const { raw, deps } = gateway(['tools:read']);
    await expect(handleMetaToolkitCall({ authorization: 'Bearer aw_fixture', toolName: 'meta_event_source_connect', args: { catalog_id: '501', pixel_id: '41' } }, deps))
      .rejects.toMatchObject({ status: 403 });
    expect(raw.runEventSourceTool).not.toHaveBeenCalled();
  });

  it('read-only key may read health; executed connect is write-metered', async () => {
    const ro = gateway(['tools:read']);
    ro.raw.runEventSourceTool.mockResolvedValueOnce({ state: 'ACTIVE' });
    await handleMetaToolkitCall({ authorization: 'Bearer aw_fixture', toolName: 'meta_event_source_get_health', args: { pixel_id: '41' } }, ro.deps);
    expect(ro.raw.recordWrite).not.toHaveBeenCalled();
    const rw = gateway(['tools:read', 'tools:execute']);
    await handleMetaToolkitCall({ authorization: 'Bearer aw_fixture', toolName: 'meta_event_source_connect', args: { catalog_id: '501', pixel_id: '41' } }, rw.deps);
    expect(rw.raw.recordWrite).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'CATALOG_EVENT_SOURCE', action: 'CREATE', verification: 'CONFIRMED' }));
  });
  it('ENG-3060: a replayed confirm is not metered as a second executed write', async () => {
    const rw = gateway(['tools:read', 'tools:execute']);
    rw.raw.runEventSourceTool.mockResolvedValueOnce({ success: true, verification: 'CONFIRMED', id: '41', replayed: true });
    await handleMetaToolkitCall({ authorization: 'Bearer aw_fixture', toolName: 'meta_event_source_connect', args: { catalog_id: '501', pixel_id: '41' } }, rw.deps);
    expect(rw.raw.recordWrite).not.toHaveBeenCalled();
  });
});
