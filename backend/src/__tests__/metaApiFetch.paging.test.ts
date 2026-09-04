// ENG-1476 follow-up — `fetchWithRetryAndPaging` must not put credential material in the
// logs, and must not follow `paging.next` without a bound.
//
// A Graph `paging.next` URL carries `access_token` in its query string, so the previous
// `substring(0, 100)` log line could emit token material on every page. And the helper
// recurses per page with no ceiling: over a large enough account that is unbounded work on
// the stack, and — worse — a stop with no signal reads to the caller as a complete result,
// which is the ENG-1584 defect.

import { fetchWithRetryAndPaging, META_PAGING_MAX_PAGES } from '../utils/metaApiFetch';

const TOKEN = 'EAAsecrettokenvalue0123456789';

function graphUrl(page: number): string {
  return `https://graph.facebook.com/v25.0/act_123/ads?access_token=${TOKEN}&limit=100&after=cursor${page}`;
}

describe('fetchWithRetryAndPaging', () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.restoreAllMocks();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  /** Serves `pages` pages, each linking to the next. */
  function mockPages(pages: number) {
    let served = 0;
    (global as any).fetch = jest.fn().mockImplementation(() => {
      served++;
      const isLast = served >= pages;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: [{ id: `row${served}` }],
            ...(isLast ? {} : { paging: { next: graphUrl(served) } }),
          }),
      });
    });
    return () => served;
  }

  it('never writes the access token to the logs while paging', async () => {
    mockPages(3);
    await fetchWithRetryAndPaging(graphUrl(0));

    const written = [...logSpy.mock.calls, ...warnSpy.mock.calls].flat().join(' ');
    expect(written).not.toContain(TOKEN);
    expect(written).not.toContain('access_token');
    // The path is still logged — redaction should not cost observability.
    expect(written).toContain('graph.facebook.com/v25.0/act_123/ads');
  });

  it('merges every page when the account fits inside the bound', async () => {
    const served = mockPages(3);
    const data = await fetchWithRetryAndPaging(graphUrl(0));

    expect(served()).toBe(3);
    expect(data.data).toHaveLength(3);
    expect(data.pagingTruncated).toBeUndefined();
    expect(data.paging).toBeUndefined();
  });

  // The bound is driven explicitly rather than through META_PAGING_MAX_PAGES so these pin the
  // BEHAVIOUR at a bound, not the constant's current value — which is deliberately large.
  it('stops at the page bound instead of recursing without limit', async () => {
    const served = mockPages(1000);
    const data = await fetchWithRetryAndPaging(graphUrl(0), 3);

    expect(served()).toBe(4);
    expect(data.data).toHaveLength(4);
  });

  it('flags a bounded stop so a short list cannot read as a complete one', async () => {
    mockPages(1000);
    const data = await fetchWithRetryAndPaging(graphUrl(0), 3);

    expect(data.pagingTruncated).toBe(true);
    const warned = warnSpy.mock.calls.flat().join(' ');
    expect(warned).toMatch(/paging stopped/i);
    expect(warned).not.toContain(TOKEN);
  });

  /*
   * `fetchWithRetry` RETURNS a non-ok Response once its retries are exhausted rather than
   * throwing, so a persistent 429/403/400 on page 2 arrives as `{ error: {...} }` with no
   * `data` and no `paging`. The merge guard skipped it, `delete data.paging` ran, and the
   * caller — which can only check page 1's own `error` field — reported page 1's rows as a
   * COMPLETE list. This is the same bad sentence as an unannounced bound, arrived at from the
   * other direction.
   */
  function mockPageThenGraphError(graphError: any) {
    let served = 0;
    (global as any).fetch = jest.fn().mockImplementation(() => {
      served++;
      if (served === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: [{ id: 'row1' }], paging: { next: graphUrl(1) } }),
        });
      }
      // Retries exhausted: fetchWithRetry hands back the non-ok Response itself.
      return Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({ error: graphError }) });
    });
    return () => served;
  }

  it('flags a page that came back unreadable, so page 1 cannot read as the whole list', async () => {
    mockPageThenGraphError({ message: '(#4) Application request limit reached', code: 4 });
    const data = await fetchWithRetryAndPaging(graphUrl(0));

    expect(data.data).toHaveLength(1);
    expect(data.pagingTruncated).toBe(true);
  });

  it('surfaces the failed page’s Graph error so a caller can say WHY the list is short', async () => {
    mockPageThenGraphError({ message: '(#4) Application request limit reached', code: 4 });
    const data = await fetchWithRetryAndPaging(graphUrl(0));

    expect(data.pagingError?.message).toContain('Application request limit reached');
  });

  it('propagates a mid-read page failure up through every enclosing page', async () => {
    // The failure is on page 3, so pages 1 and 2 both have to carry it — a caller only ever
    // sees the OUTERMOST result.
    let served = 0;
    (global as any).fetch = jest.fn().mockImplementation(() => {
      served++;
      if (served <= 2) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: [{ id: `row${served}` }], paging: { next: graphUrl(served) } }),
        });
      }
      return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: { message: 'boom' } }) });
    });

    const data = await fetchWithRetryAndPaging(graphUrl(0));

    expect(data.data).toHaveLength(2);
    expect(data.pagingTruncated).toBe(true);
    expect(data.pagingError?.message).toBe('boom');
  });

  it('does not flag a healthy read as truncated', async () => {
    mockPages(3);
    const data = await fetchWithRetryAndPaging(graphUrl(0));

    expect(data.pagingTruncated).toBeUndefined();
    expect(data.pagingError).toBeUndefined();
  });

  /*
   * The default bound must stay far above what routes/meta.ts's dashboard reads need. Those six
   * calls set no `limit`, so Meta serves 25 rows a page: a 25-page bound would have capped them
   * at 625 rows where they were previously unbounded — silently shrinking dashboards, which is
   * the defect this file exists to prevent, introduced by the guard against it.
   */
  it('keeps a default bound generous enough not to shrink an unlimited caller', async () => {
    /*
     * Driven through the DEFAULT bound rather than asserted on the constant. `expect(
     * META_PAGING_MAX_PAGES).toBeGreaterThanOrEqual(500)` pins a number, not a behaviour: it
     * stays green if the default argument stops being that constant, which is the way this
     * could actually regress.
     *
     * 501 pages at Meta's unlimited-caller default of 25 rows a page is 12,525 rows, against the
     * 625 a 25-page bound would have left those six dashboard reads with. What this actually
     * catches is the plausible regression: the default quietly becoming metaService's
     * META_LIST_MAX_PAGES (25), which pairs with an explicit limit=100 these callers do not set.
     */
    const served = mockPages(501);
    const data = await fetchWithRetryAndPaging(graphUrl(0));

    expect(served()).toBe(501);
    expect(data.data).toHaveLength(501);
    expect(data.pagingTruncated).toBeUndefined();
    expect(META_PAGING_MAX_PAGES).toBeGreaterThanOrEqual(500);
  });
});
