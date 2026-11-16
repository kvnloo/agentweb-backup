import { runMetaCatalogTool, CATALOG_PATH_RE, META_CATALOG_TOOL_DEFINITIONS, META_CATALOG_TOOL_NAMES } from '../mcp/metaToolkitCatalogs';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';

function deps(overrides: Record<string, any> = {}) {
  const calls: Array<{ path: string; params: Record<string, string> }> = [];
  const responses: Record<string, any> = {
    act_111: { business: { id: '900' } },
    '900/owned_product_catalogs': { data: [{ id: '501', name: 'Main', product_count: 3 }, { id: '503', name: 'Empty', product_count: 0 }] },
    '900/client_product_catalogs': { data: [{ id: '502', name: 'NoSets', product_count: 9 }] },
    '501/product_sets': { data: [{ id: 's1', name: 'All' }] },
    '502/product_sets': { data: [] },
    '501/product_feeds': { data: [{ id: 'f1', name: 'Daily', latest_upload: { error_count: 2 } }, { id: 'f2', latest_upload: { error_count: 0 } }] },
    '501/external_event_sources': { data: [{ id: 'px1', name: 'Pixel' }] },
    '501/diagnostics': { data: [{ type: 'X', severity: 'MUST_FIX' }, { type: 'Y', severity: 'OPPORTUNITY' }] },
    ...overrides,
  };
  const readGraph = jest.fn(async (_u: string, _a: string, path: string, params: Record<string, string>) => {
    calls.push({ path, params });
    if (!(path in responses)) throw new Error(`unexpected ${path}`);
    return responses[path];
  });
  return { d: { readGraph }, calls };
}

describe('ENG-2924 meta catalog health reads', () => {
  it('registers all four tools read-only with closed schemas', () => {
    for (const n of ['meta_list_dpa_eligible_catalogs', 'meta_get_catalog_diagnostics', 'meta_get_dynamic_ads_health', 'meta_get_catalog_data_sources']) {
      expect(META_CATALOG_TOOL_NAMES).toContain(n);
      const def: any = META_CATALOG_TOOL_DEFINITIONS.find((x) => x.name === n);
      expect(def.inputSchema.additionalProperties).toBe(false);
      expect(def.description).toMatch(/^Read-only/);
    }
    expect(CATALOG_PATH_RE.test('501/diagnostics')).toBe(true);
    expect(CATALOG_PATH_RE.test('501/external_event_sources')).toBe(true);
    expect(CATALOG_PATH_RE.test('501/batch')).toBe(false);
  });

  it('splits catalogs into DPA-eligible and ineligible with reasons', async () => {
    const { d, calls } = deps();
    const out: any = await runMetaCatalogTool('meta_list_dpa_eligible_catalogs', 'u', '111', {}, d);
    expect(out.eligible.map((c: any) => c.catalog_id)).toEqual(['501']);
    expect(out.ineligible.map((c: any) => [c.catalog_id, c.reason])).toEqual([
      ['503', 'Catalog has no products.'],
      ['502', expect.stringMatching(/no product set/)],
    ]);
    expect(calls.map((c) => c.path)).not.toContain('503/product_sets');
  });

  it('reads diagnostics and data sources only for an owned catalog', async () => {
    const { d, calls } = deps();
    const diag: any = await runMetaCatalogTool('meta_get_catalog_diagnostics', 'u', '111', { catalog_id: '501' }, d);
    expect(diag.diagnostics).toHaveLength(2);
    const src: any = await runMetaCatalogTool('meta_get_catalog_data_sources', 'u', '111', { catalog_id: '501' }, d);
    expect(src.product_feeds).toHaveLength(2);
    expect(src.event_sources[0].id).toBe('px1');
    await expect(runMetaCatalogTool('meta_get_catalog_diagnostics', 'u', '111', { catalog_id: '777' }, d)).rejects.toThrow(MetaToolkitRefusal);
    await expect(runMetaCatalogTool('meta_get_dynamic_ads_health', 'u', '111', { catalog_id: '1/../me' }, d)).rejects.toThrow(/numeric/);
    expect(calls.some((c) => c.path.startsWith('777/'))).toBe(false);
  });

  it('summarizes dynamic-ads health with blocking issues and warnings', async () => {
    const { d } = deps();
    const ok: any = await runMetaCatalogTool('meta_get_dynamic_ads_health', 'u', '111', { catalog_id: '501' }, d);
    expect(ok.ready).toBe(true);
    expect(ok.feed_errors).toEqual([{ feed_id: 'f1', name: 'Daily', error_count: 2 }]);
    expect(ok.must_fix_diagnostics).toHaveLength(1);
    expect(ok.warnings).toHaveLength(2);

    const { d: d2 } = deps({ '502/product_feeds': { data: [] }, '502/external_event_sources': { data: [] }, '502/diagnostics': { data: [] } });
    const bad: any = await runMetaCatalogTool('meta_get_dynamic_ads_health', 'u', '111', { catalog_id: '502' }, d2);
    expect(bad.ready).toBe(false);
    expect(bad.blocking_issues).toEqual(['Catalog has no product set.']);
    expect(bad.warnings[0]).toMatch(/event source/);
  });
});
