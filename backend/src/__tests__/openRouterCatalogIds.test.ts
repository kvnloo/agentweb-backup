import { CATALOG_IDS_TIMEOUT_MS, CATALOG_IDS_RETRY_MS, CATALOG_IDS_TTL_MS, createCatalogIdsSource } from '../services/agentMode/openRouterCatalogIds';

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

  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

  it('serves the stale list immediately after expiry and refreshes once in the background', async () => {
    let t = 0;
    let release: (r: Response) => void = () => undefined;
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(ok(['a/b']))
      .mockReturnValueOnce(new Promise<Response>((r) => { release = r; }));
    const source = createCatalogIdsSource({ fetch: fetchMock as unknown as typeof fetch, now: () => t });
    expect(await source.getIds()).toEqual(['a/b']);
    t += CATALOG_IDS_TTL_MS;
    // The refresh is still pending, yet the caller is not made to wait for it.
    expect(await source.getIds()).toEqual(['a/b']);
    expect(await source.getIds()).toEqual(['a/b']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    release(ok(['a/c']));
    await flush();
    expect(await source.getIds()).toEqual(['a/c']);
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
    expect(await source.getIds()).toEqual(['a/b']);
    await flush();
    expect(await source.getIds()).toEqual(['a/b']); // backed off, no extra call
    expect(fetchMock).toHaveBeenCalledTimes(2);
    t += CATALOG_IDS_RETRY_MS;
    await source.getIds(); // stale now, kicks the retry
    await flush();
    expect(await source.getIds()).toEqual(['a/c']);
  });

  it.each([
    ['an empty catalog', async () => ok([])],
    ['a non-OK response whose body has a data array', async () => ({ ok: false, status: 500, json: async () => ({ data: [{ id: 'x/y-0731' }] }) }) as unknown as Response],
    ['a rejected request', async () => { throw new Error('down'); }],
  ])('a later refresh returning %s never replaces the last good list', async (_n, bad) => {
    let t = 0;
    const fetchMock = jest.fn().mockResolvedValueOnce(ok(['a/b'])).mockImplementation(bad);
    const source = createCatalogIdsSource({ fetch: fetchMock as unknown as typeof fetch, now: () => t });
    await source.getIds();
    t += CATALOG_IDS_TTL_MS;
    await source.getIds();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await source.getIds()).toEqual(['a/b']);
  });

  it('a non-OK response with a data array is not used on a cold start either', async () => {
    const bad = { ok: false, status: 500, json: async () => ({ data: [{ id: 'x/y-0731' }] }) } as unknown as Response;
    const source = createCatalogIdsSource({ fetch: jest.fn(async () => bad) as unknown as typeof fetch });
    expect(await source.getIds()).toEqual([]);
  });

  it('aborts a hanging request at the timeout and yields []', async () => {
    jest.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const hang = jest.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => {
        signal = init?.signal as AbortSignal;
        signal.addEventListener('abort', () => rej(new Error('aborted')));
      }));
      const source = createCatalogIdsSource({ fetch: hang as unknown as typeof fetch });
      const pending = source.getIds();
      expect(signal?.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(CATALOG_IDS_TIMEOUT_MS - 1);
      expect(signal?.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(signal?.aborted).toBe(true);
      expect(await pending).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
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

  describe('degraded-check logging', () => {
    let errorSpy: jest.SpyInstance;
    beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined); });
    afterEach(() => errorSpy.mockRestore());

    const SECRET = 'https://openrouter.ai/api/v1/models?key=SECRET-TOKEN body-text-leak';
    const cases: Array<[string, () => Promise<Response>, string]> = [
      ['failed fetch', async () => { throw new TypeError(SECRET); }, 'TypeError'],
      ['non-OK response', async () => ({ ok: false, status: 500, json: async () => ({ data: [{ id: SECRET }] }) }) as unknown as Response, 'CatalogHttpError'],
      ['empty list', async () => ok([]), 'CatalogEmptyError'],
      ['response without data array', async () => ({ ok: true, status: 200, json: async () => ({ error: SECRET }) }) as unknown as Response, 'CatalogShapeError'],
      ['invalid JSON', async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError(SECRET); } }) as unknown as Response, 'SyntaxError'],
      ['non-Error rejection', async () => { throw SECRET; }, 'unknown'],
    ];

    it.each(cases)('%s logs exactly once with the class name only', async (_n, impl, expected) => {
      const source = createCatalogIdsSource({ fetch: jest.fn(impl) as unknown as typeof fetch });
      await source.getIds();
      await source.getIds(); // backed off: no second attempt, no second log
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith('OpenRouterCatalogIds: refresh failed; keeping last list', expected);
      expect(JSON.stringify(errorSpy.mock.calls)).not.toMatch(/SECRET|openrouter\.ai|body-text-leak|500/);
    });

    it('logs nothing on success or on a cache hit', async () => {
      const source = createCatalogIdsSource({ fetch: jest.fn(async () => ok(['a/b'])) as unknown as typeof fetch });
      await source.getIds();
      await source.getIds();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('logs once per failed attempt, not per caller, when parallel callers share a failing refresh', async () => {
      const source = createCatalogIdsSource({ fetch: jest.fn(async () => { throw new TypeError('x'); }) as unknown as typeof fetch });
      await Promise.all([source.getIds(), source.getIds(), source.getIds()]);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });
});
