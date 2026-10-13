import { CATALOG_IDS_RETRY_MS, CATALOG_IDS_TTL_MS, createCatalogIdsSource } from '../services/agentMode/openRouterCatalogIds';

const ok = (ids: unknown[]) => ({ ok: true, status: 200, json: async () => ({ data: ids.map((id) => ({ id })) }) }) as unknown as Response;

describe('openRouterCatalogIds', () => {
  it('returns catalog ids, ignoring rows without a vendor/name string id', async () => {
    const fetchMock = jest.fn(async () => ok(['a/b', 'a/b-0731', 5, null, 'noslash']));
    const source = createCatalogIdsSource({ fetch: fetchMock as unknown as typeof fetch });
    expect(await source.getIds()).toEqual(['a/b', 'a/b-0731']);
  });

  it('single-flights parallel callers and caches for the TTL, then refreshes', async () => {
    let t = 1000;
    const fetchMock = jest.fn(async () => ok(['a/b']));
    const source = createCatalogIdsSource({ fetch: fetchMock as unknown as typeof fetch, now: () => t });
    await Promise.all([source.getIds(), source.getIds(), source.getIds()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    t += CATALOG_IDS_TTL_MS - 1;
    await source.getIds();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    t += 1;
    await source.getIds();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good list when a refresh fails, and backs off before retrying', async () => {
    let t = 0;
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(ok(['a/b']))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(ok(['a/c']));
    const source = createCatalogIdsSource({ fetch: fetchMock as unknown as typeof fetch, now: () => t });
    expect(await source.getIds()).toEqual(['a/b']);
    t += CATALOG_IDS_TTL_MS;
    expect(await source.getIds()).toEqual(['a/b']); // refresh failed -> stale list
    expect(await source.getIds()).toEqual(['a/b']); // backed off, no extra call
    expect(fetchMock).toHaveBeenCalledTimes(2);
    t += CATALOG_IDS_RETRY_MS;
    expect(await source.getIds()).toEqual(['a/c']);
  });

  it.each([
    ['HTTP error', async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response],
    ['no data array', async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response],
    ['empty catalog', async () => ok([])],
    ['network error', async () => { throw new Error('down'); }],
  ])('never throws and yields [] with no prior list: %s', async (_name, impl) => {
    const source = createCatalogIdsSource({ fetch: jest.fn(impl) as unknown as typeof fetch });
    expect(await source.getIds()).toEqual([]);
  });
});
