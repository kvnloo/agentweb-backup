// ENG-2925: Zoma catalog product + product-set writes (mocked Graph; no network, no storage).
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
import { runMetaCatalogWriteTool, isMetaCatalogWrite, MetaCatalogWriteDeps } from '../mcp/metaToolkitCatalogWrites';
import { getMetaToolkitManifest } from '../mcp/metaToolkitManifest';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';

const notFound = () => Object.assign(new Error('Unsupported get request'), { metaError: { code: 100, message: 'Unsupported get request' } });

function graph(overrides: Record<string, any> = {}) {
  const nodes: Record<string, any> = {
    act_111: { business: { id: '900' } },
    '900/owned_product_catalogs': { data: [{ id: '501', name: 'Main', product_count: 3 }] },
    '900/client_product_catalogs': { data: [] },
    // owned product + set (catalog 501), foreign product + set (catalog 777)
    '601': { id: '601', retailer_id: 'sku1', name: 'Shoe', product_catalog: { id: '501' } },
    '602': { id: '602', retailer_id: 'x', name: 'Foreign', product_catalog: { id: '777' } },
    '701': { id: '701', name: 'All shoes', filter: '{"brand":{"i_contains":"acme"}}', product_count: 3, product_catalog: { id: '501' } },
    '702': { id: '702', name: 'Foreign set', filter: '{}', product_catalog: { id: '777' } },
    'act_111/adsets': { data: [{ id: 'as1', name: 'Paused', status: 'PAUSED', effective_status: 'PAUSED', promoted_object: { product_set_id: '701' } }] },
    '501/products': { data: [{ id: '601', retailer_id: 'sku1', name: 'Shoe' }] },
    ...overrides,
  };
  const deleted = new Set<string>();
  const reads: string[] = [];
  const writes: Array<{ method: string; path: string; params: Record<string, string> }> = [];
  const readGraph = jest.fn(async (_u: string, _a: string, path: string) => {
    reads.push(path);
    if (deleted.has(path)) throw notFound();
    const r = nodes[path];
    if (r === undefined) throw notFound();
    if (r instanceof Error) throw r;
    return r;
  });
  const writeGraph = jest.fn(async (_u: string, _a: string, method: 'POST' | 'DELETE', path: string, params: Record<string, string>) => {
    writes.push({ method, path, params });
    if (method === 'DELETE') { deleted.add(path); return { success: true }; }
    if (path === '501/products') { nodes['801'] = { id: '801', ...params, product_catalog: { id: '501' } }; return { id: '801' }; }
    if (path === '501/product_sets') { nodes['802'] = { id: '802', name: params.name, filter: params.filter, product_count: 1, product_catalog: { id: '501' } }; return { id: '802' }; }
    nodes[path] = { ...nodes[path], ...params };
    return { success: true };
  });
  const deps: MetaCatalogWriteDeps = {
    readGraph, writeGraph, secret: () => 'test-secret', now: () => 1_800_000_000_000,
    consumedTokens: new Map(), tokenOutcomes: new Map(),
  };
  return { deps, nodes, reads, writes, deleted, writeGraph };
}

const PRODUCT = { catalog_id: '501', retailer_id: 'sku9', name: 'Boot', price: 1299, currency: 'USD', url: 'https://x.test/boot', image_url: 'https://x.test/boot.png', availability: 'in stock' };

describe('ENG-2925 catalog writes', () => {
  it('advertises all seven tools; only the six mutating ones are writes', () => {
    const names = getMetaToolkitManifest().map((d: any) => d.name);
    for (const n of ['meta_product_create', 'meta_update_product', 'meta_delete_product', 'meta_get_suggested_filter', 'meta_product_set_create', 'meta_product_set_update', 'meta_product_set_delete']) {
      expect(names).toContain(n);
    }
    expect(isMetaCatalogWrite('meta_get_suggested_filter')).toBe(false);
    expect(isMetaCatalogWrite('meta_product_set_delete')).toBe(true);
  });

  it('creates a product in an owned catalog and confirms it by read-back', async () => {
    const g = graph();
    const out: any = await runMetaCatalogWriteTool('meta_product_create', 'u', '111', PRODUCT, g.deps);
    expect(out).toMatchObject({ success: true, verification: 'CONFIRMED', id: '801', catalog_id: '501' });
    expect(g.writes).toEqual([{ method: 'POST', path: '501/products', params: expect.objectContaining({ retailer_id: 'sku9', price: '1299' }) }]);
    expect(g.reads).toContain('801');
  });

  it('refuses a foreign catalog / product / set and never writes', async () => {
    const g = graph();
    await expect(runMetaCatalogWriteTool('meta_product_create', 'u', '111', { ...PRODUCT, catalog_id: '777' }, g.deps)).rejects.toThrow(/not available/);
    await expect(runMetaCatalogWriteTool('meta_update_product', 'u', '111', { product_id: '602', name: 'x' }, g.deps)).rejects.toThrow(MetaToolkitRefusal);
    await expect(runMetaCatalogWriteTool('meta_delete_product', 'u', '111', { product_id: '602' }, g.deps)).rejects.toThrow(/not in a catalog/);
    await expect(runMetaCatalogWriteTool('meta_product_set_update', 'u', '111', { product_set_id: '702', name: 'x' }, g.deps)).rejects.toThrow(/not in a catalog/);
    await expect(runMetaCatalogWriteTool('meta_get_suggested_filter', 'u', '111', { catalog_id: '777', brand: 'a' }, g.deps)).rejects.toThrow(/not available/);
    expect(g.writeGraph).not.toHaveBeenCalled();
  });

  it('reports a read-back mismatch, never success', async () => {
    const g = graph();
    g.writeGraph.mockImplementationOnce(async (_u, _a, _m, path, params) => {
      g.nodes[path] = { ...g.nodes[path], ...params, name: 'Something else' };
      return { success: true };
    });
    const out: any = await runMetaCatalogWriteTool('meta_update_product', 'u', '111', { product_id: '601', name: 'Shoe v2' }, g.deps);
    expect(out).toMatchObject({ success: false, verification: 'MISMATCH', id: '601' });
  });

  it('a write without a definite Meta answer is UNCONFIRMED; a Meta refusal is FAILED (no verification)', async () => {
    const g = graph();
    g.writeGraph.mockRejectedValueOnce(Object.assign(new Error('timeout'), { outcomeUnknown: true }));
    const unknown: any = await runMetaCatalogWriteTool('meta_product_create', 'u', '111', PRODUCT, g.deps);
    expect(unknown).toMatchObject({ success: false, verification: 'UNCONFIRMED' });
    g.writeGraph.mockRejectedValueOnce(Object.assign(new Error('bad'), { outcomeUnknown: false, metaError: { code: 100, message: 'Invalid parameter' } }));
    const failed: any = await runMetaCatalogWriteTool('meta_product_create', 'u', '111', PRODUCT, g.deps);
    expect(failed.status).toBe('FAILED');
    expect(failed.verification).toBeUndefined();
  });

  it('product set create + update verify name and filter by read-back', async () => {
    const g = graph();
    const filter = { retailer_id: { is_any: ['sku1'] } };
    const created: any = await runMetaCatalogWriteTool('meta_product_set_create', 'u', '111', { catalog_id: '501', name: 'Hero', filter }, g.deps);
    expect(created).toMatchObject({ success: true, verification: 'CONFIRMED', id: '802' });
    expect(g.writes[0].params.filter).toBe(JSON.stringify(filter));
    const updated: any = await runMetaCatalogWriteTool('meta_product_set_update', 'u', '111', { product_set_id: '701', name: 'Renamed' }, g.deps);
    expect(updated).toMatchObject({ success: true, verification: 'CONFIRMED' });
  });

  it('suggested filter is a read: builds the filter and samples matches without writing', async () => {
    const g = graph();
    const out: any = await runMetaCatalogWriteTool('meta_get_suggested_filter', 'u', '111', { catalog_id: '501', brand: 'acme', price_max: 5000 }, g.deps);
    expect(out.filter).toEqual({ and: [{ brand: { i_contains: 'acme' } }, { price: { lte: 5000 } }] });
    expect(out.sample_matches).toHaveLength(1);
    expect(g.writeGraph).not.toHaveBeenCalled();
  });

  describe('deletes (preview → confirm)', () => {
    it('delete without a token only previews; confirm without a valid token is a mismatch; nothing is deleted', async () => {
      const g = graph();
      const preview: any = await runMetaCatalogWriteTool('meta_delete_product', 'u', '111', { product_id: '601' }, g.deps);
      expect(preview).toMatchObject({ status: 'PREVIEW', success: false });
      expect(preview.preview_token).toMatch(/^v1\./);
      const noToken: any = await runMetaCatalogWriteTool('meta_delete_product', 'u', '111', { product_id: '601', confirm: true }, g.deps);
      expect(noToken.status).toBe('PREVIEW_MISMATCH');
      expect(g.writeGraph).not.toHaveBeenCalled();
    });

    it('happy path: confirm deletes once, read-back confirms; a token replay sends nothing new', async () => {
      const g = graph();
      const { preview_token } = (await runMetaCatalogWriteTool('meta_delete_product', 'u', '111', { product_id: '601' }, g.deps)) as any;
      const done: any = await runMetaCatalogWriteTool('meta_delete_product', 'u', '111', { product_id: '601', confirm: true, preview_token }, g.deps);
      expect(done).toMatchObject({ success: true, verification: 'CONFIRMED', id: '601' });
      expect(g.writes).toEqual([{ method: 'DELETE', path: '601', params: {} }]);
      // The product is gone, so a replay fails ownership before it can reach the token.
      await expect(runMetaCatalogWriteTool('meta_delete_product', 'u', '111', { product_id: '601', confirm: true, preview_token }, g.deps)).rejects.toThrow(/not found/);
      expect(g.writes).toHaveLength(1);
    });

    it('token replay against unchanged state returns the recorded outcome and does not delete again', async () => {
      const g = graph();
      g.writeGraph.mockImplementationOnce(async () => ({ success: true })); // Meta accepts but the node survives
      const { preview_token } = (await runMetaCatalogWriteTool('meta_delete_product', 'u', '111', { product_id: '601' }, g.deps)) as any;
      const first: any = await runMetaCatalogWriteTool('meta_delete_product', 'u', '111', { product_id: '601', confirm: true, preview_token }, g.deps);
      expect(first.verification).toBe('MISMATCH');
      const replay: any = await runMetaCatalogWriteTool('meta_delete_product', 'u', '111', { product_id: '601', confirm: true, preview_token }, g.deps);
      expect(replay).toMatchObject({ replayed: true, verification: 'MISMATCH' });
      expect(g.writeGraph).toHaveBeenCalledTimes(1);
      g.deps.tokenOutcomes.clear();
      await expect(runMetaCatalogWriteTool('meta_delete_product', 'u', '111', { product_id: '601', confirm: true, preview_token }, g.deps)).rejects.toThrow(/already used/);
      expect(g.writeGraph).toHaveBeenCalledTimes(1);
    });

    it('a token is bound to the target state: a renamed product needs a new preview', async () => {
      const g = graph();
      const { preview_token } = (await runMetaCatalogWriteTool('meta_delete_product', 'u', '111', { product_id: '601' }, g.deps)) as any;
      g.nodes['601'] = { ...g.nodes['601'], name: 'Renamed meanwhile' };
      const out: any = await runMetaCatalogWriteTool('meta_delete_product', 'u', '111', { product_id: '601', confirm: true, preview_token }, g.deps);
      expect(out.status).toBe('PREVIEW_MISMATCH');
      expect(g.writeGraph).not.toHaveBeenCalled();
    });

    it('refuses deleting a set an ACTIVE ad set promotes, unless confirm_in_use (bound into the token)', async () => {
      const g = graph({
        'act_111/adsets': { data: [{ id: 'as9', name: 'DPA live', status: 'ACTIVE', effective_status: 'ACTIVE', promoted_object: { product_set_id: '701' } }] },
      });
      await expect(runMetaCatalogWriteTool('meta_product_set_delete', 'u', '111', { product_set_id: '701' }, g.deps)).rejects.toThrow(/ACTIVE ad set.*as9/);
      const preview: any = await runMetaCatalogWriteTool('meta_product_set_delete', 'u', '111', { product_set_id: '701', confirm_in_use: true }, g.deps);
      expect(preview.preview).toMatch(/stop delivering/);
      // The confirm must repeat confirm_in_use: dropping it is refused before any token check.
      await expect(runMetaCatalogWriteTool('meta_product_set_delete', 'u', '111', { product_set_id: '701', confirm: true, preview_token: preview.preview_token }, g.deps)).rejects.toThrow(/ACTIVE/);
      const done: any = await runMetaCatalogWriteTool('meta_product_set_delete', 'u', '111', { product_set_id: '701', confirm_in_use: true, confirm: true, preview_token: preview.preview_token }, g.deps);
      expect(done).toMatchObject({ success: true, verification: 'CONFIRMED' });
      expect(g.writes).toEqual([{ method: 'DELETE', path: '701', params: {} }]);
    });

    it('an unused set (only a paused ad set references it) deletes without confirm_in_use', async () => {
      const g = graph();
      const { preview_token } = (await runMetaCatalogWriteTool('meta_product_set_delete', 'u', '111', { product_set_id: '701' }, g.deps)) as any;
      const done: any = await runMetaCatalogWriteTool('meta_product_set_delete', 'u', '111', { product_set_id: '701', confirm: true, preview_token }, g.deps);
      expect(done.verification).toBe('CONFIRMED');
    });
  });
});

describe('ENG-2925 gateway: scope + metering', () => {
  const accounts = [{ platform: 'meta', account_id: '111', config: { account_type: 'ad_account', ad_account_id: '111', access_token: 'x' } }];
  function gateway(scopes: string[]) {
    const raw = {
      validateApiKey: jest.fn().mockResolvedValue({ userId: 'u1', keyId: 'k1', scopes }),
      validateOAuthToken: jest.fn(),
      listAccounts: jest.fn().mockResolvedValue(accounts),
      execute: jest.fn(),
      recordUsage: jest.fn().mockResolvedValue(undefined),
      recordWrite: jest.fn().mockResolvedValue(undefined),
      now: () => Date.parse('2026-11-11T00:00:00Z'),
      rateLimiter: { check: () => ({ allowed: true, remaining: 1, resetInMs: 0 }) },
      runCatalogWriteTool: jest.fn().mockResolvedValue({ success: true, verification: 'CONFIRMED', id: '801' }),
    };
    return { raw, deps: raw as unknown as MetaToolkitGatewayDeps };
  }

  it('read-only api key is rejected 403 on a catalog write before any Meta call', async () => {
    const { raw, deps } = gateway(['tools:read']);
    await expect(handleMetaToolkitCall({ authorization: 'Bearer aw_fixture', toolName: 'meta_product_create', args: PRODUCT }, deps))
      .rejects.toMatchObject({ status: 403, message: expect.stringContaining('tools:execute') });
    expect(raw.listAccounts).not.toHaveBeenCalled();
    expect(raw.runCatalogWriteTool).not.toHaveBeenCalled();
    expect(raw.recordWrite).not.toHaveBeenCalled();
  });

  it('read-only api key may use the suggested-filter read; it is not write-metered', async () => {
    const { raw, deps } = gateway(['tools:read']);
    raw.runCatalogWriteTool.mockResolvedValueOnce({ filter: {} });
    await handleMetaToolkitCall({ authorization: 'Bearer aw_fixture', toolName: 'meta_get_suggested_filter', args: { catalog_id: '501', brand: 'a' } }, deps);
    expect(raw.runCatalogWriteTool).toHaveBeenCalledTimes(1);
    expect(raw.recordWrite).not.toHaveBeenCalled();
    expect(raw.recordUsage).toHaveBeenCalledTimes(1);
  });

  it('an executed write is metered as a write with its entity, action and verdict; a preview is not', async () => {
    const { raw, deps } = gateway(['tools:read', 'tools:execute']);
    await handleMetaToolkitCall({ authorization: 'Bearer aw_fixture', toolName: 'meta_product_create', args: PRODUCT }, deps);
    expect(raw.recordWrite).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'meta_product_create', entityType: 'PRODUCT', action: 'CREATE', verification: 'CONFIRMED', objectId: '801',
    }));
    raw.recordWrite.mockClear();
    raw.runCatalogWriteTool.mockResolvedValueOnce({ status: 'PREVIEW', preview_token: 'v1.x.y' });
    await handleMetaToolkitCall({ authorization: 'Bearer aw_fixture', toolName: 'meta_product_set_delete', args: { product_set_id: '701' } }, deps);
    expect(raw.recordWrite).not.toHaveBeenCalled();
  });
});
