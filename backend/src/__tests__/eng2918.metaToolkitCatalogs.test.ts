import { runMetaCatalogTool, CATALOG_PATH_RE } from '../mcp/metaToolkitCatalogs';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';

function deps(overrides: Record<string, any> = {}) {
  const calls: Array<{ path: string; params: Record<string, string> }> = [];
  const responses: Record<string, any> = {
    act_111: { business: { id: '900', name: 'Biz' } },
    '900/owned_product_catalogs': { data: [{ id: '501', name: 'Main', product_count: 3, vertical: 'commerce' }] },
    '900/client_product_catalogs': { data: [{ id: '502', name: 'Shared' }, { id: '501', name: 'Main dup' }] },
    '501/products': { data: [{ id: 'p1', retailer_id: 'sku1', review_status: 'approved' }], paging: { next: 'x' } },
    '502/product_sets': { data: [{ id: 's1', name: 'All' }] },
    '501/product_feeds': { data: [{ id: 'f1', latest_upload: { error_count: 2 } }] },
    ...overrides,
  };
  const readGraph = jest.fn(async (_u: string, _a: string, path: string, params: Record<string, string>) => {
    calls.push({ path, params });
    if (!(path in responses)) throw new Error(`unexpected ${path}`);
    const r = responses[path];
    if (r instanceof Error) throw r;
    return r;
  });
  return { d: { readGraph }, calls };
}

describe('ENG-2918 meta catalog reads', () => {
  it('lists owned + shared catalogs of the account business, deduped', async () => {
    const { d } = deps();
    const out: any = await runMetaCatalogTool('meta_list_catalogs', 'u', '111', {}, d);
    expect(out.business_id).toBe('900');
    expect(out.catalogs).toEqual([
      { catalog_id: '501', name: 'Main', product_count: 3, vertical: 'commerce', access: 'owned' },
      { catalog_id: '502', name: 'Shared', product_count: undefined, vertical: undefined, access: 'shared' },
    ]);
  });

  it('refuses a catalog id outside the account business and never reads it', async () => {
    const { d, calls } = deps();
    await expect(runMetaCatalogTool('meta_list_products', 'u', '111', { catalog_id: '777' }, d)).rejects.toThrow(MetaToolkitRefusal);
    expect(calls.map((c) => c.path)).not.toContain('777/products');
  });

  it('refuses non-numeric catalog ids (path injection) and bad limits', async () => {
    const { d } = deps();
    await expect(runMetaCatalogTool('meta_list_products', 'u', '111', { catalog_id: '501/../me' }, d)).rejects.toThrow(/numeric/);
    await expect(runMetaCatalogTool('meta_list_products', 'u', '111', { catalog_id: '501', limit: 500 }, d)).rejects.toThrow(/limit/);
    expect(CATALOG_PATH_RE.test('me/adaccounts')).toBe(false);
    expect(CATALOG_PATH_RE.test('501/products')).toBe(true);
  });

  it('reads products / sets / feeds of an allowed catalog and flags truncation', async () => {
    const { d, calls } = deps();
    const p: any = await runMetaCatalogTool('meta_list_products', 'u', '111', { catalog_id: '501', limit: 10 }, d);
    expect(p.products).toHaveLength(1);
    expect(p.truncated).toBe(true);
    expect(calls.find((c) => c.path === '501/products')!.params.limit).toBe('10');
    const s: any = await runMetaCatalogTool('meta_list_product_sets', 'u', '111', { catalog_id: '502' }, d);
    expect(s.product_sets[0].id).toBe('s1');
    const f: any = await runMetaCatalogTool('meta_list_product_feeds', 'u', '111', { catalog_id: '501' }, d);
    expect(f.product_feeds[0].latest_upload.error_count).toBe(2);
  });

  it('handles accounts without a business', async () => {
    const { d } = deps({ act_111: {} });
    const out: any = await runMetaCatalogTool('meta_list_catalogs', 'u', '111', {}, d);
    expect(out.catalogs).toEqual([]);
    await expect(runMetaCatalogTool('meta_list_products', 'u', '111', { catalog_id: '501' }, d)).rejects.toThrow(/Business/);
  });

  it('surfaces Meta errors as refusals without request details', async () => {
    const err: any = new Error('boom'); err.metaError = { message: 'Permissions error' };
    const { d } = deps({ '900/owned_product_catalogs': err });
    await expect(runMetaCatalogTool('meta_list_catalogs', 'u', '111', {}, d)).rejects.toThrow('Could not read catalogs from Meta: Permissions error.');
  });
});
