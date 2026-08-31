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

  it('stops at the page bound instead of recursing without limit', async () => {
    const served = mockPages(500);
    const data = await fetchWithRetryAndPaging(graphUrl(0));

    expect(served()).toBe(META_PAGING_MAX_PAGES + 1);
    expect(data.data).toHaveLength(META_PAGING_MAX_PAGES + 1);
  });

  it('flags a bounded stop so a short list cannot read as a complete one', async () => {
    mockPages(500);
    const data = await fetchWithRetryAndPaging(graphUrl(0));

    expect(data.pagingTruncated).toBe(true);
    const warned = warnSpy.mock.calls.flat().join(' ');
    expect(warned).toMatch(/paging stopped/i);
    expect(warned).not.toContain(TOKEN);
  });
});
