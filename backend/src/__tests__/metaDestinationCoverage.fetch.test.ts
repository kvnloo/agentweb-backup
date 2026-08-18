/**
 * ENG-926 §G — the Meta reads behind the destination check.
 *
 * `fetchHtml` is injected, so the REAL ENG-941 checker runs here rather than a mock of it.
 * That is deliberate: the thing most likely to break this check is the seam between the two
 * modules (the `PIXEL:` label, the ownership comparison, the dedupe), and a mocked gate would
 * assert nothing about any of them.
 */

import {
  fetchDestinationInputs,
  evaluateDestinationCoverage,
  DESTINATION_ADS_PAGE_SIZE,
  MAX_DESTINATION_URLS_CHECKED,
} from '../services/metaDestinationCoverage';

const ADS_PAGE = {
  data: [
    {
      id: '111',
      name: 'Lead Ad',
      effective_status: 'ACTIVE',
      campaign: { id: 'c1', name: 'Phoenix FFL', objective: 'OUTCOME_LEADS' },
      creative: { object_story_spec: { link_data: { link: 'https://lander.test/lp' } } },
    },
    {
      id: '222',
      name: 'Instant Form Ad',
      effective_status: 'ACTIVE',
      campaign: { id: 'c1', name: 'Phoenix FFL', objective: 'OUTCOME_LEADS' },
      creative: { object_story_spec: {} },
    },
  ],
};

const PIXELS_PAGE = { data: [{ id: '910841031004192' }] };

/** A fetch stub that answers the ads edge, then the pixels edge, in call order. */
const metaFetch = (adsPages: any[], pixels: any = PIXELS_PAGE) => {
  let adsCalls = 0;
  const calls: string[] = [];
  const impl = jest.fn(async (url: string) => {
    calls.push(url);
    if (url.includes('/adspixels')) {
      return { ok: true, status: 200, json: async () => pixels } as any;
    }
    const page = adsPages[Math.min(adsCalls++, adsPages.length - 1)];
    return { ok: true, status: 200, json: async () => page } as any;
  });
  return { impl, calls };
};

const html = (pixelId?: string) =>
  pixelId
    ? `<html><head><script>fbq('init', '${pixelId}');</script></head><body>hi</body></html>`
    : '<html><head></head><body>no tracking here</body></html>';

describe('fetchDestinationInputs — Meta reads', () => {
  it('maps ads, campaign objective and creative destinations', async () => {
    const { impl } = metaFetch([ADS_PAGE]);
    const inputs = await fetchDestinationInputs('123', 'tok', {
      fetchImpl: impl as any,
      fetchHtml: async () => html('910841031004192'),
    });

    expect(inputs.status).toBe('ok');
    expect(inputs.ads).toHaveLength(2);
    expect(inputs.ads[0]).toMatchObject({
      adId: '111', campaignName: 'Phoenix FFL', objective: 'OUTCOME_LEADS',
      destinationUrls: ['https://lander.test/lp'],
    });
    // The instant-form ad genuinely has no destination — half of real ACTIVE ads look like this.
    expect(inputs.ads[1].destinationUrls).toEqual([]);
    expect(inputs.ownedPixelIds).toEqual(['910841031004192']);
  });

  it('asks Meta for ACTIVE ads only, and NOT 200 at a time', async () => {
    // 200 returned "Please reduce the amount of data you're asking for" on a real account,
    // because of the nested creative expansion. Pinned so a future tidy-up cannot restore it.
    const { impl, calls } = metaFetch([ADS_PAGE]);
    await fetchDestinationInputs('123', 'tok', {
      fetchImpl: impl as any,
      fetchHtml: async () => html('910841031004192'),
    });
    const adsCall = calls.find((c) => c.includes('/ads?'))!;
    expect(decodeURIComponent(adsCall)).toContain('["ACTIVE"]');
    expect(adsCall).toContain(`limit=${DESTINATION_ADS_PAGE_SIZE}`);
    expect(DESTINATION_ADS_PAGE_SIZE).toBeLessThan(200);
  });

  it('follows paging', async () => {
    const first = {
      data: ADS_PAGE.data,
      paging: { next: 'https://graph.facebook.com/v25.0/act_123/ads?after=CURSOR' },
    };
    const { impl } = metaFetch([first, { data: [] }]);
    const inputs = await fetchDestinationInputs('123', 'tok', {
      fetchImpl: impl as any,
      fetchHtml: async () => html('910841031004192'),
    });
    expect(inputs.ads).toHaveLength(2);
  });

  it('a failed ADS read is fetch_error — there is no claim left to test', async () => {
    const impl = jest.fn(async () => ({
      ok: false, status: 400,
      json: async () => ({ error: { message: 'Please reduce the amount of data' } }),
    })) as any;
    const inputs = await fetchDestinationInputs('123', 'tok', { fetchImpl: impl });
    expect(inputs.status).toBe('fetch_error');
    expect(inputs.error).toContain('reduce the amount of data');
    expect(inputs.ads).toEqual([]);
  });

  it('a failed PIXEL read is fetch_error, NOT an account with no pixels', async () => {
    // The dangerous confusion: "we could not read the pixels" and "this account owns none"
    // produce opposite conclusions, and one of them silently clears every destination.
    const impl = jest.fn(async (url: string) => {
      if (url.includes('/adspixels')) {
        return { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) } as any;
      }
      return { ok: true, status: 200, json: async () => ADS_PAGE } as any;
    }) as any;
    const inputs = await fetchDestinationInputs('123', 'tok', { fetchImpl: impl });
    expect(inputs.status).toBe('fetch_error');
    expect(inputs.ownedPixelIds).toEqual([]);
  });
});

describe('fetchDestinationInputs — the ENG-941 seam', () => {
  it('strips the PIXEL: label so ownership can be compared', async () => {
    const { impl } = metaFetch([ADS_PAGE]);
    const inputs = await fetchDestinationInputs('123', 'tok', {
      fetchImpl: impl as any,
      fetchHtml: async () => html('910841031004192'),
    });
    expect(inputs.observations['https://lander.test/lp'].detectedPixelIds)
      .toEqual(['910841031004192']);
  });

  it('end to end: an owned pixel on the page is clean', async () => {
    const { impl } = metaFetch([ADS_PAGE]);
    const inputs = await fetchDestinationInputs('123', 'tok', {
      fetchImpl: impl as any,
      fetchHtml: async () => html('910841031004192'),
    });
    const verdict = evaluateDestinationCoverage(inputs.ads, inputs.observations, inputs.ownedPixelIds);
    expect(verdict.alerting).toEqual([]);
    expect(verdict.okCount).toBe(1);
  });

  it('end to end: a page carrying SOMEONE ELSE\'S pixel alerts as foreign_pixel', async () => {
    const { impl } = metaFetch([ADS_PAGE]);
    const inputs = await fetchDestinationInputs('123', 'tok', {
      fetchImpl: impl as any,
      fetchHtml: async () => html('999999999999999'),
    });
    const verdict = evaluateDestinationCoverage(inputs.ads, inputs.observations, inputs.ownedPixelIds);
    expect(verdict.alerting).toEqual([
      expect.objectContaining({ adId: '111', reason: 'foreign_pixel' }),
    ]);
  });

  it('end to end: a page with no tracking at all alerts as no_pixel', async () => {
    const { impl } = metaFetch([ADS_PAGE]);
    const inputs = await fetchDestinationInputs('123', 'tok', {
      fetchImpl: impl as any,
      fetchHtml: async () => html(),
    });
    const verdict = evaluateDestinationCoverage(inputs.ads, inputs.observations, inputs.ownedPixelIds);
    expect(verdict.alerting).toEqual([
      expect.objectContaining({ adId: '111', reason: 'no_pixel' }),
    ]);
  });

  it('a 403 from the site is unverifiable and pages NOBODY', async () => {
    // One of the four real destinations in production answers 403 to a plain fetch.
    const { impl } = metaFetch([ADS_PAGE]);
    const inputs = await fetchDestinationInputs('123', 'tok', {
      fetchImpl: impl as any,
      fetchHtml: async () => { throw new Error('Request failed with status code 403'); },
    });
    const verdict = evaluateDestinationCoverage(inputs.ads, inputs.observations, inputs.ownedPixelIds);
    expect(verdict.alerting).toEqual([]);
    expect(verdict.unverifiable).toEqual([
      expect.objectContaining({ adId: '111', error: expect.stringContaining('403') }),
    ]);
  });

  it('a total failure of the HTML checker still returns ok, and alerts nobody', async () => {
    const { impl } = metaFetch([ADS_PAGE]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const inputs = await fetchDestinationInputs('123', 'tok', {
      fetchImpl: impl as any,
      // Throwing synchronously from the boundary is caught per-URL by the gate, so force a
      // failure of the gate call itself by making the URL list unusable downstream.
      fetchHtml: (() => { throw new Error('checker exploded'); }) as any,
    });
    expect(inputs.status).toBe('ok');
    const verdict = evaluateDestinationCoverage(inputs.ads, inputs.observations, inputs.ownedPixelIds);
    expect(verdict.alerting).toEqual([]);
    warn.mockRestore();
  });
});

describe('fetchDestinationInputs — defensive against what Meta actually returns', () => {
  const inputsFor = async (adsBody: any, pixelsBody: any = PIXELS_PAGE) => {
    const impl = jest.fn(async (url: string) => ({
      ok: true, status: 200,
      json: async () => (url.includes('/adspixels') ? pixelsBody : adsBody),
    })) as any;
    return fetchDestinationInputs('123', 'tok', {
      fetchImpl: impl,
      fetchHtml: async () => html('910841031004192'),
    });
  };

  it('tolerates a data field that is not an array', async () => {
    const inputs = await inputsFor({ data: null }, { data: undefined });
    expect(inputs.status).toBe('ok');
    expect(inputs.ads).toEqual([]);
    expect(inputs.ownedPixelIds).toEqual([]);
  });

  it('tolerates rows with no campaign, no creative and no id', async () => {
    const inputs = await inputsFor({ data: [{}] });
    expect(inputs.ads).toEqual([expect.objectContaining({ adId: '', destinationUrls: [] })]);
    expect(inputs.ads[0].campaignId).toBeUndefined();
    expect(inputs.ads[0].objective).toBeUndefined();
  });

  it('coerces a numeric campaign id rather than dropping it', async () => {
    const inputs = await inputsFor({
      data: [{ id: 7, campaign: { id: 42, name: 'C', objective: 'OUTCOME_LEADS' }, creative: {} }],
    });
    expect(inputs.ads[0]).toMatchObject({ adId: '7', campaignId: '42' });
  });

  it('stops paging when next is present but not a string', async () => {
    const inputs = await inputsFor({ data: [], paging: { next: { href: 'nope' } } });
    expect(inputs.status).toBe('ok');
  });

  it('ignores pixel rows carrying no id', async () => {
    const inputs = await inputsFor({ data: [] }, { data: [{ name: 'no id here' }, { id: 5 }] });
    expect(inputs.ownedPixelIds).toEqual(['5']);
  });

  it('falls back to the HTTP status when Meta returns an error with no message', async () => {
    const impl = jest.fn(async () => ({
      ok: false, status: 503, json: async () => ({ error: {} }),
    })) as any;
    const inputs = await fetchDestinationInputs('123', 'tok', { fetchImpl: impl });
    expect(inputs.status).toBe('fetch_error');
    expect(inputs.error).toBe('HTTP 503');
  });

  it('treats a 200 carrying an error body as a failure, not as data', async () => {
    // Graph does this: HTTP 200 with `{"error": …}` inside. Reading `ok` alone would accept it.
    const impl = jest.fn(async () => ({
      ok: true, status: 200, json: async () => ({ error: { message: 'rate limited' } }),
    })) as any;
    const inputs = await fetchDestinationInputs('123', 'tok', { fetchImpl: impl });
    expect(inputs.status).toBe('fetch_error');
    expect(inputs.error).toBe('rate limited');
  });

  it('surfaces a thrown transport error rather than swallowing it', async () => {
    const impl = jest.fn(async () => { throw new Error('socket hang up'); }) as any;
    const inputs = await fetchDestinationInputs('123', 'tok', { fetchImpl: impl });
    expect(inputs).toMatchObject({ status: 'fetch_error', error: 'socket hang up' });
  });

  it('reports a non-Error throw without producing "undefined"', async () => {
    const impl = jest.fn(async () => { throw 'nope'; }) as any;
    const inputs = await fetchDestinationInputs('123', 'tok', { fetchImpl: impl });
    expect(inputs.error).toBe('request failed');
  });

  it('tolerates a body that is not an object at all', async () => {
    // Seen from proxies and error pages: a 200 whose body parses to null or a bare string.
    const inputs = await inputsFor(null, 'not json at all');
    expect(inputs.status).toBe('ok');
    expect(inputs.ads).toEqual([]);
  });

  it('skips null rows inside the ads array', async () => {
    const inputs = await inputsFor({ data: [null, undefined, { id: '9', creative: {} }] });
    expect(inputs.ads.map((a) => a.adId)).toEqual(['9']);
  });

  it('reports the HTTP status when the failure body carries no error object', async () => {
    const impl = jest.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })) as any;
    const inputs = await fetchDestinationInputs('123', 'tok', { fetchImpl: impl });
    expect(inputs).toMatchObject({ status: 'fetch_error', error: 'HTTP 502' });
  });

  it('reports a thrown null without rendering "undefined" into the log', async () => {
    const impl = jest.fn(async () => { throw null; }) as any;
    const inputs = await fetchDestinationInputs('123', 'tok', { fetchImpl: impl });
    expect(inputs).toMatchObject({ status: 'fetch_error', error: 'request failed' });
  });

  it('honours META_API_VERSION', async () => {
    const previous = process.env.META_API_VERSION;
    process.env.META_API_VERSION = 'v99.0';
    try {
      const { impl, calls } = metaFetch([{ data: [] }]);
      await fetchDestinationInputs('123', 'tok', { fetchImpl: impl as any });
      expect(calls[0]).toContain('/v99.0/');
    } finally {
      if (previous === undefined) delete process.env.META_API_VERSION;
      else process.env.META_API_VERSION = previous;
    }
  });

  it('uses global fetch when no fetchImpl is injected', async () => {
    const previous = (global as any).fetch;
    (global as any).fetch = jest.fn(async (url: string) => ({
      ok: true, status: 200,
      json: async () => (url.includes('/adspixels') ? PIXELS_PAGE : { data: [] }),
    }));
    try {
      const inputs = await fetchDestinationInputs('123', 'tok');
      expect(inputs.status).toBe('ok');
      expect((global as any).fetch).toHaveBeenCalled();
    } finally {
      (global as any).fetch = previous;
    }
  });
});

describe('fetchDestinationInputs — caps', () => {
  it('reports destinations past the cap rather than dropping them silently', async () => {
    const many = {
      data: Array.from({ length: MAX_DESTINATION_URLS_CHECKED + 4 }, (_, i) => ({
        id: `ad_${i}`,
        campaign: { id: 'c', name: 'C', objective: 'OUTCOME_LEADS' },
        creative: { object_story_spec: { link_data: { link: `https://lander.test/lp${i}` } } },
      })),
    };
    const { impl } = metaFetch([many]);
    const inputs = await fetchDestinationInputs('123', 'tok', {
      fetchImpl: impl as any,
      fetchHtml: async () => html('910841031004192'),
    });
    expect(Object.keys(inputs.observations)).toHaveLength(MAX_DESTINATION_URLS_CHECKED);
    expect(inputs.urlsNotChecked).toHaveLength(4);
  });
});
