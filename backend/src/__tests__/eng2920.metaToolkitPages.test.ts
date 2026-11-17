import { runMetaPagesTool, PAGES_PATH_RE, META_PAGES_TOOL_DEFINITIONS, META_PAGES_TOOL_NAMES } from '../mcp/metaToolkitPages';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';

function deps(responses: Record<string, any>) {
  const calls: Array<{ path: string; params: Record<string, string> }> = [];
  return {
    calls,
    readGraph: jest.fn(async (_u: string, _a: string, path: string, params: Record<string, string>) => {
      calls.push({ path, params });
      if (!(path in responses)) throw new Error(`unexpected ${path}`);
      return responses[path];
    }),
  };
}

describe('ENG-2920 Zoma Pages / Instagram / Ad Library reads', () => {
  it('advertises one definition per tool name, all read-only (no write verbs)', () => {
    expect(META_PAGES_TOOL_DEFINITIONS.map((d) => d.name)).toEqual([...META_PAGES_TOOL_NAMES]);
    expect(META_PAGES_TOOL_NAMES).not.toContain('ads_boost_ig_post');
  });

  it('path allowlist rejects foreign ad accounts and arbitrary edges', () => {
    expect(PAGES_PATH_RE.test('act_1/promote_pages')).toBe(true);
    expect(PAGES_PATH_RE.test('123/media')).toBe(true);
    expect(PAGES_PATH_RE.test('123/ads')).toBe(false);
    expect(PAGES_PATH_RE.test('me/adaccounts')).toBe(false);
  });

  it('ads_get_ad_account_pages reads the resolved account promote_pages', async () => {
    const d = deps({ 'act_42/promote_pages': { data: [{ id: '9', name: 'P' }], paging: { next: 'x' } } });
    const out: any = await runMetaPagesTool('ads_get_ad_account_pages', 'u', '42', {}, d);
    expect(d.calls[0].path).toBe('act_42/promote_pages');
    expect(out.pages).toEqual([{ id: '9', name: 'P' }]);
    expect(out.truncated).toBe(true);
  });

  it('ads_get_pages_for_business merges owned + shared pages of the account business only', async () => {
    const d = deps({
      act_42: { business: { id: '777' } },
      '777/owned_pages': { data: [{ id: '1' }] },
      '777/client_pages': { data: [{ id: '1' }, { id: '2' }] },
    });
    const out: any = await runMetaPagesTool('ads_get_pages_for_business', 'u', 'act_42', {}, d);
    expect(out.pages).toEqual([{ id: '1', access: 'owned' }, { id: '2', access: 'shared' }]);
  });

  it('ads_get_pages_for_business explains a non-business account', async () => {
    const d = deps({ act_42: {} });
    const out: any = await runMetaPagesTool('ads_get_pages_for_business', 'u', '42', {}, d);
    expect(out.pages).toEqual([]);
    expect(out.note).toMatch(/Business portfolio/);
  });

  it('ads_get_user_pages never returns page access tokens', async () => {
    const d = deps({ 'me/accounts': { data: [{ id: '5', name: 'X', access_token: 'SECRET' }] } });
    const out: any = await runMetaPagesTool('ads_get_user_pages', 'u', '42', {}, d);
    expect(JSON.stringify(out)).not.toContain('SECRET');
  });

  it('ads_get_ig_media refuses an Instagram account not usable by the ad account', async () => {
    const d = deps({ 'act_42/instagram_accounts': { data: [{ id: '100' }] } });
    await expect(runMetaPagesTool('ads_get_ig_media', 'u', '42', { ig_account_id: '200' }, d)).rejects.toThrow(MetaToolkitRefusal);
    expect(d.calls.map((c) => c.path)).toEqual(['act_42/instagram_accounts']);
  });

  it('ads_get_ig_media reads media of an owned Instagram account', async () => {
    const d = deps({ 'act_42/instagram_accounts': { data: [{ id: '100' }] }, '100/media': { data: [{ id: 'm1' }] } });
    const out: any = await runMetaPagesTool('ads_get_ig_media', 'u', '42', { ig_account_id: '100', limit: 5 }, d);
    expect(out.media).toEqual([{ id: 'm1' }]);
    expect(d.calls[1].params.limit).toBe('5');
  });

  it('ads_library_search validates countries and requires terms or page ids', async () => {
    const d = deps({ ads_archive: { data: [{ id: 'a' }] } });
    await expect(runMetaPagesTool('ads_library_search', 'u', '42', { search_terms: 'x' }, d)).rejects.toThrow(/ad_reached_countries/);
    await expect(runMetaPagesTool('ads_library_search', 'u', '42', { ad_reached_countries: ['us'], search_terms: 'x' }, d)).rejects.toThrow(MetaToolkitRefusal);
    await expect(runMetaPagesTool('ads_library_search', 'u', '42', { ad_reached_countries: ['US'] }, d)).rejects.toThrow(/search_terms or search_page_ids/);
    const out: any = await runMetaPagesTool('ads_library_search', 'u', '42', { ad_reached_countries: ['US'], search_terms: 'shoes' }, d);
    expect(out.ads).toEqual([{ id: 'a' }]);
    expect(d.calls[0].params).toMatchObject({ ad_reached_countries: '["US"]', search_terms: 'shoes', ad_active_status: 'ALL' });
  });

  it('ads_library_search logs a Meta rejection (Meta fields only) and points a permission error at identity confirmation', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const rejected: any = new Error('(#10) Application does not have permission for this action');
      rejected.metaError = { code: 10, error_subcode: 2332004, message: rejected.message };
      const d = { readGraph: jest.fn().mockRejectedValue(rejected) };
      const search = { ad_reached_countries: ['US'], search_terms: 'shoes' };
      await expect(runMetaPagesTool('ads_library_search', 'u', '42', search, d)).rejects.toThrow(/does not have permission[\s\S]*facebook\.com\/ID/);
      expect(warn).toHaveBeenCalledWith('[meta-toolkit] ads_library_search rejected by Meta', expect.objectContaining({ code: 10, subcode: 2332004 }));
      // A missing-scope error and an unrelated failure on the same call carry no identity hint.
      d.readGraph.mockRejectedValue(Object.assign(new Error('(#200) Requires ads_read permission'), { metaError: { code: 200, message: '(#200) Requires ads_read permission' } }));
      await expect(runMetaPagesTool('ads_library_search', 'u', '42', search, d)).rejects.toThrow(/^Could not read from Meta: \(#200\) Requires ads_read permission\.$/);
      d.readGraph.mockRejectedValue(Object.assign(new Error('Please reduce the amount of data'), { metaError: { code: 1, message: 'Please reduce the amount of data' } }));
      await expect(runMetaPagesTool('ads_library_search', 'u', '42', search, d)).rejects.toThrow(/^Could not read from Meta: Please reduce the amount of data\.$/);
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects out-of-range limits and wraps Meta errors as refusals', async () => {
    const d = deps({});
    await expect(runMetaPagesTool('ads_get_ig_accounts', 'u', '42', { limit: 500 }, d)).rejects.toThrow(/limit/);
    await expect(runMetaPagesTool('ads_get_ig_accounts', 'u', '42', {}, d)).rejects.toThrow(/Could not read from Meta/);
  });
});
