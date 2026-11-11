// ENG-2926: Zoma catalog create/update, product feeds, upload sessions, feed rules (mocked Graph).
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
import { runMetaCatalogFeedTool, isMetaCatalogFeedWrite, validateFeedUrl, MetaCatalogFeedDeps } from '../mcp/metaToolkitCatalogFeeds';
import { getMetaToolkitManifest } from '../mcp/metaToolkitManifest';

const NOW = Date.parse('2026-11-11T12:00:00Z');

function graph() {
  const nodes: Record<string, any> = {
    act_111: { business: { id: '900' } },
    '900/owned_product_catalogs': { data: [{ id: '501', name: 'Main' }] },
    '900/client_product_catalogs': { data: [{ id: '601', name: 'Shared' }] },
    '501/product_feeds': { data: [{ id: '71', name: 'Daily', product_count: 10 }] },
    '601/product_feeds': { data: [{ id: '81', name: 'Theirs' }] },
    '71/uploads': { data: [{ id: '3001', url: 'https://feeds.example.com/f.csv?sig=secret', num_detected_items: 10 }] },
    '71/rules': { data: [{ id: '9001', attribute: 'price', rule_type: 'fallback_rule' }] },
  };
  let seq = 0;
  const writes: Array<{ method: string; path: string; params: Record<string, string> }> = [];
  const readGraph = jest.fn(async (_u: string, _a: string, path: string) => {
    const r = nodes[path];
    if (r === undefined) throw Object.assign(new Error('not found'), { metaError: { code: 100, message: 'not found' } });
    return r;
  });
  const writeGraph = jest.fn(async (_u: string, _a: string, method: 'POST' | 'DELETE', path: string, params: Record<string, string>) => {
    writes.push({ method, path, params });
    const id = String(5000 + ++seq);
    if (method === 'DELETE') {
      for (const k of Object.keys(nodes)) if (Array.isArray(nodes[k]?.data)) nodes[k] = { data: nodes[k].data.filter((x: any) => x.id !== path) };
      return { success: true };
    }
    const [node, edge] = path.split('/');
    if (!edge) {
      for (const k of Object.keys(nodes)) if (Array.isArray(nodes[k]?.data)) nodes[k] = { data: nodes[k].data.map((x: any) => (x.id === node ? { ...x, ...params } : x)) };
      return { success: true };
    }
    nodes[path] = { data: [...(nodes[path]?.data ?? []), { id, ...params }] };
    return { id };
  });
  const deps: MetaCatalogFeedDeps = { readGraph, writeGraph, secret: () => 's', now: () => NOW, consumedTokens: new Map(), tokenOutcomes: new Map() };
  return { deps, nodes, writes };
}

describe('ENG-2926 catalog feeds', () => {
  it('advertises the tools; reads are not writes', () => {
    const names = getMetaToolkitManifest().map((d: any) => d.name);
    for (const n of ['meta_catalog_create', 'meta_catalog_update', 'meta_product_feed_create', 'meta_product_feed_update', 'meta_product_feed_delete',
      'meta_feed_upload_create', 'meta_feed_upload_get', 'meta_feed_rule_create', 'meta_feed_rule_get', 'meta_feed_rule_delete', 'meta_list_product_feeds']) {
      expect(names).toContain(n);
    }
    expect(isMetaCatalogFeedWrite('meta_feed_rule_get')).toBe(false);
    expect(isMetaCatalogFeedWrite('meta_feed_upload_get')).toBe(false);
    expect(isMetaCatalogFeedWrite('meta_product_feed_delete')).toBe(true);
  });

  it('validates feed URLs: https only, no credentials, query redacted', () => {
    expect(() => validateFeedUrl('http://x.com/f.csv')).toThrow(/https/);
    expect(() => validateFeedUrl('https://u:p@x.com/f.csv')).toThrow(/username or password/);
    expect(() => validateFeedUrl('ftp://x')).toThrow();
    expect(validateFeedUrl('https://x.com/f.csv?token=abc').display).toBe('https://x.com/f.csv?…');
  });

  it('creates and renames a catalog, verified by read-back', async () => {
    const g = graph();
    const created: any = await runMetaCatalogFeedTool('meta_catalog_create', 'u', '111', { name: 'New' }, g.deps);
    expect(created).toMatchObject({ success: true, verification: 'CONFIRMED', id: '5001' });
    expect(g.writes[0]).toEqual({ method: 'POST', path: '900/owned_product_catalogs', params: { name: 'New' } });
    const renamed: any = await runMetaCatalogFeedTool('meta_catalog_update', 'u', '111', { catalog_id: '501', name: 'Main 2' }, g.deps);
    expect(renamed).toMatchObject({ success: true, verification: 'CONFIRMED', id: '501' });
  });

  it('refuses shared/foreign catalogs and foreign feeds without writing', async () => {
    const g = graph();
    await expect(runMetaCatalogFeedTool('meta_catalog_update', 'u', '111', { catalog_id: '601', name: 'x' }, g.deps)).rejects.toThrow(/shared/);
    await expect(runMetaCatalogFeedTool('meta_product_feed_create', 'u', '111', { catalog_id: '777', name: 'x' }, g.deps)).rejects.toThrow(/not available/);
    await expect(runMetaCatalogFeedTool('meta_feed_rule_get', 'u', '111', { catalog_id: '501', feed_id: '81' }, g.deps)).rejects.toThrow(/not a feed of catalog/);
    await expect(runMetaCatalogFeedTool('meta_product_feed_create', 'u', '111', { catalog_id: '501', name: 'x', url: 'http://a.com/f', interval: 'DAILY' }, g.deps)).rejects.toThrow(/https/);
    expect(g.writes).toEqual([]);
  });

  it('creates a scheduled feed and an upload session; get redacts the URL query', async () => {
    const g = graph();
    const feed: any = await runMetaCatalogFeedTool('meta_product_feed_create', 'u', '111', { catalog_id: '501', name: 'Hourly', url: 'https://x.com/f.csv', interval: 'HOURLY' }, g.deps);
    expect(feed).toMatchObject({ success: true, verification: 'CONFIRMED' });
    expect(JSON.parse(g.writes[0].params.schedule)).toEqual({ url: 'https://x.com/f.csv', interval: 'HOURLY' });
    const up: any = await runMetaCatalogFeedTool('meta_feed_upload_create', 'u', '111', { catalog_id: '501', feed_id: '71', url: 'https://x.com/f.csv?sig=k' }, g.deps);
    expect(up).toMatchObject({ success: true, verification: 'CONFIRMED', url: 'https://x.com/f.csv?…' });
    const got: any = await runMetaCatalogFeedTool('meta_feed_upload_get', 'u', '111', { catalog_id: '501', feed_id: '71', upload_id: '3001' }, g.deps);
    expect(got.upload.url).toBe('https://feeds.example.com/f.csv?…');
    expect(JSON.stringify(got)).not.toContain('secret');
  });

  it('feed delete and rule delete require preview → confirm and are read back', async () => {
    const g = graph();
    const p: any = await runMetaCatalogFeedTool('meta_feed_rule_delete', 'u', '111', { catalog_id: '501', feed_id: '71', rule_id: '9001' }, g.deps);
    expect(p.status).toBe('PREVIEW');
    expect(g.writes).toEqual([]);
    await expect(runMetaCatalogFeedTool('meta_feed_rule_delete', 'u', '111', { catalog_id: '501', feed_id: '71', rule_id: '9001', confirm: true }, g.deps))
      .resolves.toMatchObject({ status: 'PREVIEW_MISMATCH' });
    const done: any = await runMetaCatalogFeedTool('meta_feed_rule_delete', 'u', '111', { catalog_id: '501', feed_id: '71', rule_id: '9001', confirm: true, preview_token: p.preview_token }, g.deps);
    expect(done).toMatchObject({ success: true, verification: 'CONFIRMED' });
    expect(g.writes).toEqual([{ method: 'DELETE', path: '9001', params: {} }]);

    const fp: any = await runMetaCatalogFeedTool('meta_product_feed_delete', 'u', '111', { catalog_id: '501', feed_id: '71' }, g.deps);
    const fd: any = await runMetaCatalogFeedTool('meta_product_feed_delete', 'u', '111', { catalog_id: '501', feed_id: '71', confirm: true, preview_token: fp.preview_token }, g.deps);
    expect(fd).toMatchObject({ success: true, verification: 'CONFIRMED' });
  });

  it('rule create is read back; MISMATCH when Meta accepts but the rule is absent', async () => {
    const g = graph();
    const ok: any = await runMetaCatalogFeedTool('meta_feed_rule_create', 'u', '111', { catalog_id: '501', feed_id: '71', attribute: 'brand', rule_type: 'fallback_rule', params: { value: 'Acme' } }, g.deps);
    expect(ok).toMatchObject({ success: true, verification: 'CONFIRMED' });
    g.deps.writeGraph = jest.fn().mockResolvedValue({ id: '424242' });
    const bad: any = await runMetaCatalogFeedTool('meta_feed_rule_create', 'u', '111', { catalog_id: '501', feed_id: '71', attribute: 'brand', rule_type: 'fallback_rule', params: { value: 'Acme' } }, g.deps);
    expect(bad).toMatchObject({ success: false, verification: 'MISMATCH' });
  });
});

describe('ENG-2926 gateway: scope + metering', () => {
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
      runCatalogFeedTool: jest.fn().mockResolvedValue({ success: true, verification: 'CONFIRMED', id: '71' }),
    };
    return { raw, deps: raw as unknown as MetaToolkitGatewayDeps };
  }

  it('read-only key is rejected on feed create before any Meta call', async () => {
    const { raw, deps } = gateway(['tools:read']);
    await expect(handleMetaToolkitCall({ authorization: 'Bearer aw_fixture', toolName: 'meta_product_feed_create', args: { catalog_id: '501', name: 'x' } }, deps))
      .rejects.toMatchObject({ status: 403 });
    expect(raw.runCatalogFeedTool).not.toHaveBeenCalled();
  });

  it('read-only key may read rules; executed catalog create is write-metered', async () => {
    const ro = gateway(['tools:read']);
    ro.raw.runCatalogFeedTool.mockResolvedValueOnce({ rules: [] });
    await handleMetaToolkitCall({ authorization: 'Bearer aw_fixture', toolName: 'meta_feed_rule_get', args: { catalog_id: '501', feed_id: '71' } }, ro.deps);
    expect(ro.raw.recordWrite).not.toHaveBeenCalled();
    const rw = gateway(['tools:read', 'tools:execute']);
    await handleMetaToolkitCall({ authorization: 'Bearer aw_fixture', toolName: 'meta_catalog_create', args: { name: 'x' } }, rw.deps);
    expect(rw.raw.recordWrite).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'CATALOG', action: 'CREATE', verification: 'CONFIRMED' }));
  });
});
