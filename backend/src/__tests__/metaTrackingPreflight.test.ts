/**
 * ENG-941 — deterministic pre-flight tracking gate for Meta campaign launches.
 *
 * Mirrors googleAdsTrackingPreflight.test.ts. Every case runs with the fetch boundary
 * injected, so nothing here touches the network.
 */
import {
  detectMetaPixels,
  preflightMetaTrackingGate,
  META_TRACKING_MECHANISMS,
} from '../services/metaTrackingPreflight';

const PIXEL = '1012387921717047';
const OTHER_PIXEL = '1311221084072225';

const pixelHtml = (id: string) => `
<!doctype html><html><head>
<script>!function(f,b,e,v,n,t,s){/* fbevents */}(window,document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '${id}');
fbq('track', 'PageView');
</script>
<noscript><img height="1" width="1" style="display:none"
src="https://www.facebook.com/tr?id=${id}&ev=PageView&noscript=1"/></noscript>
</head><body>hello</body></html>`;

describe('detectMetaPixels', () => {
  it('finds a pixel id from an fbq init call', () => {
    expect(detectMetaPixels(`fbq('init', '${PIXEL}');`)).toEqual([`PIXEL:${PIXEL}`]);
  });

  it('finds a pixel id from the noscript tracking image', () => {
    expect(detectMetaPixels(`<img src="https://www.facebook.com/tr?id=${PIXEL}&ev=PageView"/>`)).toEqual([
      `PIXEL:${PIXEL}`,
    ]);
  });

  it('accepts double-quoted init calls and arbitrary whitespace', () => {
    expect(detectMetaPixels(`fbq(  "init" ,   "${PIXEL}" )`)).toEqual([`PIXEL:${PIXEL}`]);
  });

  it('de-duplicates a pixel that appears in both the script and the noscript fallback', () => {
    expect(detectMetaPixels(pixelHtml(PIXEL))).toEqual([`PIXEL:${PIXEL}`]);
  });

  it('reports every distinct pixel when a page carries more than one', () => {
    const html = pixelHtml(PIXEL) + pixelHtml(OTHER_PIXEL);
    expect(detectMetaPixels(html).sort()).toEqual([`PIXEL:${PIXEL}`, `PIXEL:${OTHER_PIXEL}`].sort());
  });

  it('returns nothing for a page with no pixel', () => {
    expect(detectMetaPixels('<html><body>no tracking here</body></html>')).toEqual([]);
  });

  it('does not treat the fbevents script alone as a pixel — a loaded library that never inits measures nothing', () => {
    expect(detectMetaPixels('<script src="https://connect.facebook.net/en_US/fbevents.js"></script>')).toEqual([]);
  });

  it('is safe on empty and non-string input', () => {
    expect(detectMetaPixels('')).toEqual([]);
    expect(detectMetaPixels(undefined as any)).toEqual([]);
    expect(detectMetaPixels(null as any)).toEqual([]);
  });

  it('ignores a GA4/GTM-only page — Google tags are not Meta measurement', () => {
    expect(detectMetaPixels('<script src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>')).toEqual([]);
  });
});

describe('preflightMetaTrackingGate', () => {
  const fetchOk = (html: string) => async () => html;

  it('passes when the destination carries a pixel belonging to the ad account', async () => {
    const gate = await preflightMetaTrackingGate(['https://site.example/lp'], [PIXEL], {
      fetchHtml: fetchOk(pixelHtml(PIXEL)),
    });
    expect(gate.ok).toBe(true);
    expect(gate.blockedUrls).toEqual([]);
    expect(gate.results[0].status).toBe('measured');
    expect(gate.results[0].mechanisms).toEqual([`PIXEL:${PIXEL}`]);
  });

  it('blocks a destination with no pixel at all, naming the url and what was checked', async () => {
    const gate = await preflightMetaTrackingGate(['https://site.example/lp'], [PIXEL], {
      fetchHtml: fetchOk('<html><body>nothing</body></html>'),
    });
    expect(gate.ok).toBe(false);
    expect(gate.results[0].status).toBe('unmeasured');
    expect(gate.message).toContain('https://site.example/lp');
    expect(gate.message).toContain(META_TRACKING_MECHANISMS[0]);
  });

  /*
   * The RankAI/hireemma failure: a pixel is present, so a naive "is there tracking?"
   * check passes, but it belongs to someone else — the campaign optimises against a
   * pixel that will never receive these conversions.
   */
  it("blocks when the page's pixel is not one of the ad account's pixels", async () => {
    const gate = await preflightMetaTrackingGate(['https://site.example/lp'], [PIXEL], {
      fetchHtml: fetchOk(pixelHtml(OTHER_PIXEL)),
    });
    expect(gate.ok).toBe(false);
    expect(gate.results[0].status).toBe('unmeasured');
    expect(gate.message).toContain(OTHER_PIXEL);
    expect(gate.message).toContain(PIXEL);
  });

  it('passes when the page carries several pixels and one of them is the account\'s', async () => {
    const gate = await preflightMetaTrackingGate(['https://site.example/lp'], [PIXEL], {
      fetchHtml: fetchOk(pixelHtml(OTHER_PIXEL) + pixelHtml(PIXEL)),
    });
    expect(gate.ok).toBe(true);
    expect(gate.results[0].status).toBe('measured');
  });

  it('treats a fetch failure as unverifiable and blocks — never a silent pass', async () => {
    const gate = await preflightMetaTrackingGate(['https://site.example/lp'], [PIXEL], {
      fetchHtml: async () => {
        throw new Error('Request failed with status code 503');
      },
    });
    expect(gate.ok).toBe(false);
    expect(gate.results[0].status).toBe('unverifiable');
    expect(gate.results[0].error).toContain('503');
    expect(gate.blockedUrls).toHaveLength(1);
  });

  it('blocks when the ad account has no pixel at all — nothing could ever report a conversion', async () => {
    const gate = await preflightMetaTrackingGate(['https://site.example/lp'], [], {
      fetchHtml: fetchOk(pixelHtml(PIXEL)),
    });
    expect(gate.ok).toBe(false);
    expect(gate.message.toLowerCase()).toContain('no meta pixel');
  });

  it('checks every destination and blocks if any single one is unmeasured', async () => {
    const byUrl: Record<string, string> = {
      'https://site.example/good': pixelHtml(PIXEL),
      'https://site.example/bad': '<html><body>nothing</body></html>',
    };
    const gate = await preflightMetaTrackingGate(Object.keys(byUrl), [PIXEL], {
      fetchHtml: async (u: string) => byUrl[u],
    });
    expect(gate.ok).toBe(false);
    expect(gate.results).toHaveLength(2);
    expect(gate.blockedUrls.map(r => r.url)).toEqual(['https://site.example/bad']);
    expect(gate.message).toContain('https://site.example/bad');
    expect(gate.message).not.toContain('https://site.example/good');
  });

  it('de-duplicates repeated destinations so one page is fetched once', async () => {
    const seen: string[] = [];
    const gate = await preflightMetaTrackingGate(
      ['https://site.example/lp', 'https://site.example/lp'],
      [PIXEL],
      {
        fetchHtml: async (u: string) => {
          seen.push(u);
          return pixelHtml(PIXEL);
        },
      },
    );
    expect(seen).toHaveLength(1);
    expect(gate.results).toHaveLength(1);
    expect(gate.ok).toBe(true);
  });

  it('passes vacuously when there are no destinations to check', async () => {
    const gate = await preflightMetaTrackingGate([], [PIXEL], { fetchHtml: fetchOk('') });
    expect(gate.ok).toBe(true);
    expect(gate.results).toEqual([]);
  });

  it('ignores malformed destination values rather than throwing', async () => {
    const gate = await preflightMetaTrackingGate(['', null as any, undefined as any], [PIXEL], {
      fetchHtml: fetchOk(pixelHtml(PIXEL)),
    });
    expect(gate.ok).toBe(true);
    expect(gate.results).toEqual([]);
  });
});

describe('destinations a pixel could never live on (ENG-941)', () => {
  const fetchSpy = jest.fn();

  beforeEach(() => fetchSpy.mockReset());

  it.each([
    ['whatsapp://send?phone=123'],
    ['fb-messenger://user/123'],
    ['tel:+15551234'],
    ['mailto:sales@example.com'],
    ['https://apps.apple.com/us/app/thing/id123'],
    ['https://play.google.com/store/apps/details?id=com.thing'],
    ['not a url at all'],
  ])('skips %s instead of blocking on it', async (url) => {
    const gate = await preflightMetaTrackingGate([url], ['1012387921717047'], { fetchHtml: fetchSpy });
    expect(gate.ok).toBe(true);
    expect(gate.results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still checks a normal web destination alongside a deep link', async () => {
    fetchSpy.mockResolvedValue('<html>nothing</html>');
    const gate = await preflightMetaTrackingGate(
      ['whatsapp://send?phone=123', 'https://site.example/lp'],
      ['1012387921717047'],
      { fetchHtml: fetchSpy },
    );
    expect(gate.ok).toBe(false);
    expect(gate.results.map(r => r.url)).toEqual(['https://site.example/lp']);
  });

  it('fetches destinations concurrently rather than one after another', async () => {
    let inFlight = 0, peak = 0;
    const slow = async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 10));
      inFlight--;
      return '<html>nothing</html>';
    };
    const urls = Array.from({ length: 10 }, (_, i) => `https://site.example/p${i}`);
    await preflightMetaTrackingGate(urls, ['1012387921717047'], { fetchHtml: slow });
    expect(peak).toBeGreaterThan(1);
  });
});
