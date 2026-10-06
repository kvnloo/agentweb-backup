/** ENG-2325 — the tracker ingest's short-TTL list cache: hit / miss / TTL / invalidate / bounds / single-flight. */
import {
  IngestListCache, parseIngestListCacheTtl, INGEST_LIST_CACHE_DEFAULT_TTL_MS, INGEST_LIST_CACHE_MAX_TTL_MS,
} from '../ingestListCache';

const ROW = { listId: 'list_a', userId: 'u1', listType: 'session', publicAccessEnabled: true, trackingConfig: { allowedOrigins: ['https://go.example.com'] }, leadCount: 99, fieldNames: ['x'], apiKey: 'secret' };

const make = (over: Partial<ConstructorParameters<typeof IngestListCache>[0]> = {}) => {
  let t = 1_000_000;
  const cache = new IngestListCache({ ttlMs: 20_000, negativeTtlMs: 5_000, maxEntries: 3, maxNegative: 2, now: () => t, ...over });
  return { cache, advance: (ms: number) => { t += ms; } };
};
const loader = (rows: Record<string, any> = { list_a: ROW }) => jest.fn(async (id: string) => rows[id] ?? null);

describe('IngestListCache', () => {
  it('N reads of one list within the TTL cost ONE load; the next window loads again', async () => {
    const { cache, advance } = make(); const load = loader();
    for (let i = 0; i < 50; i++) expect((await cache.get('list_a', load))?.publicAccessEnabled).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    advance(19_999); await cache.get('list_a', load); expect(load).toHaveBeenCalledTimes(1);
    advance(2); await cache.get('list_a', load); expect(load).toHaveBeenCalledTimes(2);
  });

  it('stores only the fields the ingest reads, frozen (no apiKey / counts / fieldNames; cannot be mutated through)', async () => {
    const { cache } = make();
    const v = (await cache.get('list_a', loader()))!;
    expect(Object.keys(v).sort()).toEqual(['listId', 'listType', 'publicAccessEnabled', 'trackingConfig', 'userId']);
    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen((v as any).trackingConfig.allowedOrigins)).toBe(true);
    const src: any = { ...ROW, trackingConfig: { allowedOrigins: ['https://a.example'] } };
    const c2 = await cache.get('list_b', async () => src);
    src.trackingConfig.allowedOrigins.push('https://evil.example');
    expect((c2 as any).trackingConfig.allowedOrigins).toEqual(['https://a.example']); // a copy, not the caller's object
  });

  it('concurrent misses share one load (single-flight)', async () => {
    const { cache } = make(); const load = loader();
    const r = await Promise.all(Array.from({ length: 30 }, () => cache.get('list_a', load)));
    expect(load).toHaveBeenCalledTimes(1);
    expect(new Set(r).size).toBe(1);
    expect(cache.size().loading).toBe(0);
  });

  it('invalidate drops the entry: the next read loads the NEW row', async () => {
    const { cache } = make(); let row: any = ROW;
    const load = jest.fn(async () => row);
    expect((await cache.get('list_a', load))?.publicAccessEnabled).toBe(true);
    row = { ...ROW, publicAccessEnabled: false };
    expect((await cache.get('list_a', load))?.publicAccessEnabled).toBe(true); // still cached
    cache.invalidate('list_a');
    expect((await cache.get('list_a', load))?.publicAccessEnabled).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('an in-flight load that started BEFORE an invalidate neither is stored nor is joined by later readers', async () => {
    const { cache } = make();
    let release!: (r: any) => void;
    const slow = jest.fn(() => new Promise<any>((res) => { release = res; }));
    const pending = cache.get('list_a', slow);
    await Promise.resolve();
    cache.invalidate('list_a');
    const fresh = jest.fn(async () => ({ ...ROW, publicAccessEnabled: false }));
    expect((await cache.get('list_a', fresh))?.publicAccessEnabled).toBe(false); // did not join the old load
    release(ROW); await pending;                                                  // old (pre-write) row resolves late
    expect((await cache.get('list_a', fresh))?.publicAccessEnabled).toBe(false); // and was NOT stored over the new one
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it('a failed load is not cached (the error propagates, the next call retries)', async () => {
    const { cache } = make();
    const load = jest.fn().mockRejectedValueOnce(new Error('throttled')).mockResolvedValue(ROW);
    await expect(cache.get('list_a', load)).rejects.toThrow('throttled');
    expect((await cache.get('list_a', load))?.listId).toBe('list_a');
    expect(cache.size().loading).toBe(0);
  });

  it('a synchronously-throwing loader is a rejection, not a crash, and leaves nothing in flight', async () => {
    const { cache } = make();
    await expect(cache.get('list_a', () => { throw new Error('sync'); })).rejects.toThrow('sync');
    expect(cache.size()).toEqual({ positive: 0, negative: 0, loading: 0 });
  });

  describe('negative entries (unknown list ids)', () => {
    it('are cached for the SHORT negative TTL only', async () => {
      const { cache, advance } = make(); const load = loader({});
      for (let i = 0; i < 10; i++) expect(await cache.get('list_missing', load)).toBeNull();
      expect(load).toHaveBeenCalledTimes(1);
      advance(5_001); await cache.get('list_missing', load); expect(load).toHaveBeenCalledTimes(2);
    });

    it('are bounded: 1000 distinct unknown ids never hold more than maxNegative entries (oldest first out)', async () => {
      const { cache } = make(); const load = loader({});
      for (let i = 0; i < 1000; i++) await cache.get(`list_unknown_${i}`, load);
      expect(cache.size().negative).toBe(2);
      expect(cache.size().positive).toBe(0);
      await cache.get('list_unknown_999', load); expect(load).toHaveBeenCalledTimes(1000); // newest still cached
      await cache.get('list_unknown_0', load); expect(load).toHaveBeenCalledTimes(1001);   // oldest evicted
    });

    it('a flood of unknown ids cannot evict real entries (separate bounds)', async () => {
      const { cache } = make({ maxEntries: 3, maxNegative: 2 });
      const rows: any = { a1: { ...ROW, listId: 'a1' }, a2: { ...ROW, listId: 'a2' } };
      const load = loader(rows);
      await cache.get('a1', load); await cache.get('a2', load);
      for (let i = 0; i < 500; i++) await cache.get(`nope_${i}`, load);
      const before = load.mock.calls.length;
      await cache.get('a1', load); await cache.get('a2', load);
      expect(load.mock.calls.length).toBe(before);
    });

    it('a list created later is seen as soon as the negative entry expires, or at once after invalidate', async () => {
      const { cache, advance } = make(); const rows: any = {}; const load = loader(rows);
      expect(await cache.get('list_a', load)).toBeNull();
      rows.list_a = ROW;
      expect(await cache.get('list_a', load)).toBeNull();
      cache.invalidate('list_a'); expect((await cache.get('list_a', load))?.listId).toBe('list_a');
      cache.invalidate('list_a'); rows.list_a = undefined; expect(await cache.get('list_a', load)).toBeNull();
      rows.list_a = ROW; advance(5_001); expect((await cache.get('list_a', load))?.listId).toBe('list_a');
    });
  });

  it('positive entries are bounded too: the oldest is evicted past maxEntries', async () => {
    const { cache } = make({ maxEntries: 3 });
    const rows: any = Object.fromEntries(['l1', 'l2', 'l3', 'l4', 'l5'].map((id) => [id, { ...ROW, listId: id }]));
    const load = loader(rows);
    for (const id of Object.keys(rows)) await cache.get(id, load);
    expect(cache.size().positive).toBe(3);
    await cache.get('l5', load); expect(load).toHaveBeenCalledTimes(5);
    await cache.get('l1', load); expect(load).toHaveBeenCalledTimes(6);
  });

  it('expired entries are dropped before live ones when trimming', async () => {
    const { cache, advance } = make({ maxEntries: 2 });
    const rows: any = Object.fromEntries(['l1', 'l2', 'l3'].map((id) => [id, { ...ROW, listId: id }]));
    const load = loader(rows);
    await cache.get('l1', load); advance(15_000); await cache.get('l2', load); advance(6_000); // l1 expired, l2 live
    await cache.get('l3', load);
    const n = load.mock.calls.length; await cache.get('l2', load); expect(load.mock.calls.length).toBe(n);
  });

  it('ttl 0 turns the cache off: every call loads (and still returns the projection)', async () => {
    const { cache } = make({ ttlMs: 0 }); const load = loader();
    for (let i = 0; i < 5; i++) expect(Object.keys((await cache.get('list_a', load))!)).not.toContain('apiKey');
    expect(load).toHaveBeenCalledTimes(5);
    expect(cache.size()).toEqual({ positive: 0, negative: 0, loading: 0 });
  });

  it('clear() empties everything', async () => {
    const { cache } = make(); const load = loader();
    await cache.get('list_a', load); await cache.get('zzzzzz', load); cache.clear();
    expect(cache.size()).toEqual({ positive: 0, negative: 0, loading: 0 });
  });
});

describe('parseIngestListCacheTtl (env)', () => {
  it.each([
    [undefined, INGEST_LIST_CACHE_DEFAULT_TTL_MS], ['', INGEST_LIST_CACHE_DEFAULT_TTL_MS], ['abc', INGEST_LIST_CACHE_DEFAULT_TTL_MS],
    ['-5', INGEST_LIST_CACHE_DEFAULT_TTL_MS], ['1.5', INGEST_LIST_CACHE_DEFAULT_TTL_MS], ['15000', 15_000], ['30000', 30_000], ['0', 0],
    [' 25000 ', 25_000], ['99999999', INGEST_LIST_CACHE_MAX_TTL_MS],
  ])('%j -> %j', (raw, want) => expect(parseIngestListCacheTtl(raw as any)).toBe(want));

  it('the default is within the 15-30s the ticket asks for', () => {
    expect(INGEST_LIST_CACHE_DEFAULT_TTL_MS).toBeGreaterThanOrEqual(15_000);
    expect(INGEST_LIST_CACHE_DEFAULT_TTL_MS).toBeLessThanOrEqual(30_000);
  });
});
