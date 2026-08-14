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
    // Wrapped in <script> because that is the only place an fbq call executes — a bare
    // fragment is prose, and treating it as an install is the false pass Greptile found.
    expect(detectMetaPixels(`<script>fbq('init', '${PIXEL}');</script>`)).toEqual([`PIXEL:${PIXEL}`]);
  });

  it('finds a pixel id from the noscript tracking image', () => {
    expect(detectMetaPixels(`<img src="https://www.facebook.com/tr?id=${PIXEL}&ev=PageView"/>`)).toEqual([
      `PIXEL:${PIXEL}`,
    ]);
  });

  it('accepts double-quoted init calls and arbitrary whitespace', () => {
    expect(detectMetaPixels(`<script>fbq(  "init" ,   "${PIXEL}" )</script>`)).toEqual([`PIXEL:${PIXEL}`]);
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

describe('inert pixel text is not an install (ENG-941, Greptile)', () => {
  const fetchOk = (html: string) => async () => html;
  const PX = '1012387921717047';

  it('ignores a commented-out pixel', async () => {
    const g = await preflightMetaTrackingGate(['https://s/lp'], [PX], {
      fetchHtml: fetchOk(`<html><head><!-- ${pixelHtml(PX)} --></head><body>x</body></html>`),
    });
    expect(g.results[0].status).toBe('unmeasured');
  });

  it('ignores a pixel shown inside a code sample', async () => {
    const g = await preflightMetaTrackingGate(['https://s/lp'], [PX], {
      fetchHtml: fetchOk(`<html><body><pre>fbq('init', '${PX}');</pre></body></html>`),
    });
    expect(g.results[0].status).toBe('unmeasured');
  });

  it('ignores an escaped snippet in prose, as a docs page would render it', async () => {
    const g = await preflightMetaTrackingGate(['https://s/lp'], [PX], {
      fetchHtml: fetchOk(`<html><body>Add &lt;script&gt;fbq('init','${PX}')&lt;/script&gt; to your head.</body></html>`),
    });
    expect(g.results[0].status).toBe('unmeasured');
  });

  it('still detects a real install on a page that also documents one', async () => {
    const g = await preflightMetaTrackingGate(['https://s/lp'], [PX], {
      fetchHtml: fetchOk(`<html><head>${pixelHtml(PX)}</head><body><pre>fbq('init','999999999')</pre></body></html>`),
    });
    expect(g.results[0].status).toBe('measured');
  });
});

describe('only executable script counts (ENG-941, Greptile round 2)', () => {
  const fetchOk = (html: string) => async () => html;
  const PX2 = '1012387921717047';

  it('ignores a pixel id sitting in a JSON config block', async () => {
    const g = await preflightMetaTrackingGate(['https://s/lp'], [PX2], {
      fetchHtml: fetchOk(`<html><head><script type="application/json">{"snippet":"fbq('init','${PX2}')"}</script></head></html>`),
    });
    expect(g.results[0].status).toBe('unmeasured');
  });

  it('ignores a pixel inside a non-executing template block', async () => {
    const g = await preflightMetaTrackingGate(['https://s/lp'], [PX2], {
      fetchHtml: fetchOk(`<html><head><script type="text/template">fbq('init','${PX2}');</script></head></html>`),
    });
    expect(g.results[0].status).toBe('unmeasured');
  });

  it('ignores an fbq call written in plain prose outside any script', async () => {
    const g = await preflightMetaTrackingGate(['https://s/lp'], [PX2], {
      fetchHtml: fetchOk(`<html><body><p>Paste fbq('init', '${PX2}') into your head tag.</p></body></html>`),
    });
    expect(g.results[0].status).toBe('unmeasured');
  });

  it('still detects a real install, including type="module" and no-type scripts', async () => {
    for (const attr of ['', ' type="text/javascript"', ' type="module"']) {
      const g = await preflightMetaTrackingGate(['https://s/lp'], [PX2], {
        fetchHtml: fetchOk(`<html><head><script${attr}>fbq('init','${PX2}');</script></head></html>`),
      });
      expect(g.results[0].status).toBe('measured');
    }
  });
});

/*
 * Greptile P1, round 3 ("Inert JavaScript passes preflight"). Restricting the scan to
 * executable <script> blocks was the second narrowing and still not enough: pixel-shaped
 * text inside a JS comment or a string literal sits in an executable block and never runs.
 * A page that merely *shows* an install snippet then reads as measured, which is exactly
 * the page this gate exists to catch.
 */
describe('detectMetaPixels — inert JavaScript inside an executable script', () => {
  it('ignores an fbq init inside a // line comment', () => {
    expect(detectMetaPixels(`<script>
      // fbq('init', '${PIXEL}');
      console.log('no tracking');
    </script>`)).toEqual([]);
  });

  it('ignores an fbq init inside a /* block comment */', () => {
    expect(detectMetaPixels(`<script>/* example: fbq('init', '${PIXEL}') */</script>`)).toEqual([]);
  });

  it('ignores an fbq init that only exists inside a string literal', () => {
    expect(detectMetaPixels(
      `<script>var snippet = "fbq('init', '${PIXEL}');"; document.title = snippet;</script>`,
    )).toEqual([]);
  });

  it('ignores an fbq init inside a template literal', () => {
    expect(detectMetaPixels(
      '<script>const help = `paste fbq(\'init\', \'' + PIXEL + '\')  into your head tag`;</script>',
    )).toEqual([]);
  });

  it('ignores a noscript tracking URL that only exists inside a JS string', () => {
    expect(detectMetaPixels(
      `<script>var sample = "<img src='https://www.facebook.com/tr?id=${PIXEL}&ev=PageView'/>";</script>`,
    )).toEqual([]);
  });

  it('still detects a real install that sits alongside commented-out example code', () => {
    expect(detectMetaPixels(`<script>
      // old pixel, removed: fbq('init', '${OTHER_PIXEL}');
      fbq('init', '${PIXEL}');
    </script>`)).toEqual([`PIXEL:${PIXEL}`]);
  });

  it('still detects a real install written with double quotes after a comment', () => {
    expect(detectMetaPixels(
      `<script>/* base code */ fbq("init", "${PIXEL}"); fbq("track", "PageView");</script>`,
    )).toEqual([`PIXEL:${PIXEL}`]);
  });

  it('does not let an apostrophe in a comment swallow a real install below it', () => {
    expect(detectMetaPixels(`<script>
      // don't remove this
      fbq('init', '${PIXEL}');
    </script>`)).toEqual([`PIXEL:${PIXEL}`]);
  });
});

/*
 * Greptile P1, round 4 ("Fallback URL text passes tracking"). The noscript fallback was
 * matched anywhere in the document, so a page that merely MENTIONS the URL — a link to it,
 * a support article quoting it, an analytics dashboard printing it — reported the account's
 * pixel as installed. The `<img>` beacon is the thing that actually fires; the text is not.
 */
describe('detectMetaPixels — the noscript fallback must be a real request', () => {
  it('ignores the tracking URL sitting in ordinary prose', () => {
    expect(detectMetaPixels(
      `<html><body><p>Your beacon is https://www.facebook.com/tr?id=${PIXEL}&ev=PageView</p></body></html>`,
    )).toEqual([]);
  });

  it('ignores the tracking URL used as a link target rather than an image', () => {
    expect(detectMetaPixels(
      `<a href="https://www.facebook.com/tr?id=${PIXEL}&ev=PageView">docs</a>`,
    )).toEqual([]);
  });

  it('still detects the real noscript beacon', () => {
    expect(detectMetaPixels(
      `<noscript><img height="1" width="1" style="display:none"
       src="https://www.facebook.com/tr?id=${PIXEL}&ev=PageView&noscript=1"/></noscript>`,
    )).toEqual([`PIXEL:${PIXEL}`]);
  });

  it('detects a beacon whose src attribute is unquoted or single-quoted', () => {
    expect(detectMetaPixels(`<img src='https://www.facebook.com/tr?id=${PIXEL}&ev=PageView'/>`)).toEqual([`PIXEL:${PIXEL}`]);
    expect(detectMetaPixels(`<img width=1 src=https://www.facebook.com/tr?id=${PIXEL} />`)).toEqual([`PIXEL:${PIXEL}`]);
  });
});

/*
 * Greptile P1, round 5. Two more inert containers the scanner passed through:
 * a regex literal (real code, but a pattern is never an initialization), and a
 * <template> element, whose contents are parsed but never rendered or requested.
 */
describe('detectMetaPixels — regex literals and inert containers', () => {
  it('ignores an fbq init that only appears inside a regex literal', () => {
    expect(detectMetaPixels(
      // Unescaped parens: a valid regex with capture groups, and the exact text the
      // matcher looks for. The escaped form would pass trivially and prove nothing.
      `<script>var re = /fbq('init','${PIXEL}')/; if (re.test(src)) report();</script>`,
    )).toEqual([]);
  });

  it('does not mistake division for a regex and swallow a real install', () => {
    expect(detectMetaPixels(
      `<script>var half = total / 2; var r = (a + b) / 2; fbq('init', '${PIXEL}');</script>`,
    )).toEqual([`PIXEL:${PIXEL}`]);
  });

  it('ignores a tracking beacon inside a <template> — parsed, never requested', () => {
    expect(detectMetaPixels(
      `<template><img height="1" width="1" src="https://www.facebook.com/tr?id=${PIXEL}&ev=PageView"/></template>`,
    )).toEqual([]);
  });

  it('ignores an fbq init inside a <template>', () => {
    expect(detectMetaPixels(
      `<template><script>fbq('init', '${PIXEL}');</script></template>`,
    )).toEqual([]);
  });
});

/*
 * Greptile P1, round 6. Two narrower versions of the same two holes: a regex in a
 * KEYWORD-led expression position (`return /…/`), which a character-only allowlist cannot
 * see, and the tracking URL sitting in a non-source attribute of an <img>, which the
 * browser never requests.
 */
describe('detectMetaPixels — keyword-led regex and non-source attributes', () => {
  it('ignores a pixel-shaped regex returned from a function', () => {
    expect(detectMetaPixels(
      `<script>function p(){ return /fbq('init','${PIXEL}')/; }</script>`,
    )).toEqual([]);
  });

  it('ignores a pixel-shaped regex in other keyword positions', () => {
    expect(detectMetaPixels(`<script>if (typeof /fbq('init','${PIXEL}')/ === 'object') x();</script>`)).toEqual([]);
    expect(detectMetaPixels(`<script>switch (s) { case /fbq('init','${PIXEL}')/: break; }</script>`)).toEqual([]);
  });

  it('does not treat an identifier ending in a keyword as a regex position', () => {
    // `myreturn / 2` is division; mis-reading it would swallow the real install after it.
    expect(detectMetaPixels(
      `<script>var x = myreturn / 2; fbq('init', '${PIXEL}');</script>`,
    )).toEqual([`PIXEL:${PIXEL}`]);
  });

  it('ignores the tracking URL in an inert attribute of an image', () => {
    expect(detectMetaPixels(
      `<img src="/logo.png" data-doc="https://www.facebook.com/tr?id=${PIXEL}&ev=PageView"/>`,
    )).toEqual([]);
  });

  it('still detects the beacon when the tracking URL IS the src', () => {
    expect(detectMetaPixels(
      `<img data-note="example" src="https://www.facebook.com/tr?id=${PIXEL}&ev=PageView"/>`,
    )).toEqual([`PIXEL:${PIXEL}`]);
  });
});

/*
 * Greptile P1, round 7. `\bsrc` has a word boundary before it inside `data-src`, so the
 * previous round's fix still read a lazy-load/documentation attribute as the image source.
 */
describe('detectMetaPixels — the beacon src must be the real src attribute', () => {
  // No plain `src` on the tag at all: with one present the old pattern matched IT first and
  // the bug hid behind attribute ordering. This is the shape that actually reproduces.
  it('ignores a beacon URL parked in data-src', () => {
    expect(detectMetaPixels(
      `<img class="beacon" data-src="https://www.facebook.com/tr?id=${PIXEL}&ev=PageView"/>`,
    )).toEqual([]);
  });

  it('ignores a beacon URL in any other -src suffixed attribute', () => {
    expect(detectMetaPixels(
      `<img lazy-src="https://www.facebook.com/tr?id=${PIXEL}"/>`,
    )).toEqual([]);
  });

  it('does not confuse srcset with src', () => {
    expect(detectMetaPixels(
      `<img srcset="https://www.facebook.com/tr?id=${PIXEL} 2x" src="/logo.png"/>`,
    )).toEqual([]);
  });

  it('still detects the beacon on a newline-separated src attribute', () => {
    expect(detectMetaPixels(`<img height="1"\n  src="https://www.facebook.com/tr?id=${PIXEL}&ev=PageView"/>`))
      .toEqual([`PIXEL:${PIXEL}`]);
  });
});

/*
 * Greptile P1, round 9. Two more precision failures in the same two scanners: a regex after
 * a CONTROL parenthesis (`if (x) /…/.test(s)`), which the position classifier read as
 * division, and an <img> whose non-source attribute VALUE contains serialized `src="…"`
 * markup, which the raw-tag regex bound to as though it were the real source.
 */
describe('detectMetaPixels — control-flow regex and embedded attribute markup', () => {
  it('ignores a pixel-shaped regex used as a test after an if(...)', () => {
    expect(detectMetaPixels(
      `<script>if (x) /fbq('init','${PIXEL}')/.test(s) && go();</script>`,
    )).toEqual([]);
  });

  it('ignores one after while(...) and for(...) too', () => {
    expect(detectMetaPixels(`<script>while (n) /fbq('init','${PIXEL}')/.exec(s);</script>`)).toEqual([]);
    expect(detectMetaPixels(`<script>for (;;) /fbq('init','${PIXEL}')/.exec(s);</script>`)).toEqual([]);
  });

  it('still treats a parenthesised expression followed by a slash as division', () => {
    expect(detectMetaPixels(
      `<script>var avg = (a + b) / 2; fbq('init', '${PIXEL}');</script>`,
    )).toEqual([`PIXEL:${PIXEL}`]);
  });

  it('ignores serialized img markup embedded in another attribute value', () => {
    expect(detectMetaPixels(
      `<img alt="paste this: &nbsp; src=&quot;x&quot;" data-doc='example src="https://www.facebook.com/tr?id=${PIXEL}"' src="/logo.png"/>`,
    )).toEqual([]);
  });

  it('still reads the real src when other attributes are present', () => {
    expect(detectMetaPixels(
      `<img data-doc='some notes' src="https://www.facebook.com/tr?id=${PIXEL}&ev=PageView" alt="x"/>`,
    )).toEqual([`PIXEL:${PIXEL}`]);
  });
});

/*
 * Greptile P1, round 10. Two more inert regions: a script whose type merely CONTAINS
 * "javascript" (`text/javascript-template` is a template, not code — per the HTML spec an
 * unrecognised type is never executed), and markup sitting as text inside a <style> block.
 */
describe('detectMetaPixels — script types and style blocks', () => {
  it('ignores a script whose type only contains "javascript"', () => {
    expect(detectMetaPixels(
      `<script type="text/javascript-template">fbq('init', '${PIXEL}');</script>`,
    )).toEqual([]);
  });

  it('ignores other template-ish types built on the same substrings', () => {
    expect(detectMetaPixels(`<script type="application/javascript+handlebars">fbq('init','${PIXEL}')</script>`)).toEqual([]);
    expect(detectMetaPixels(`<script type="text/x-module">fbq('init','${PIXEL}')</script>`)).toEqual([]);
  });

  it('still executes the standard executable types, including a charset parameter', () => {
    expect(detectMetaPixels(`<script type="text/javascript">fbq('init','${PIXEL}')</script>`)).toEqual([`PIXEL:${PIXEL}`]);
    expect(detectMetaPixels(`<script type="application/javascript; charset=utf-8">fbq('init','${PIXEL}')</script>`)).toEqual([`PIXEL:${PIXEL}`]);
    expect(detectMetaPixels(`<script type="module">fbq('init','${PIXEL}')</script>`)).toEqual([`PIXEL:${PIXEL}`]);
  });

  it('ignores beacon markup sitting as text inside a <style> block', () => {
    expect(detectMetaPixels(
      `<style>/* <img src="https://www.facebook.com/tr?id=${PIXEL}"/> */ body{color:red}</style>`,
    )).toEqual([]);
  });
});

/*
 * Greptile P1, round 11. The type parser required quotes, so `<script type=text/template>`
 * — valid HTML — read as executable. Same lesson as the <img> src fix: attribute values come
 * in three forms and matching only one of them is a hole, not a simplification.
 */
describe('detectMetaPixels — unquoted script type attributes', () => {
  it('ignores an unquoted non-executable type', () => {
    expect(detectMetaPixels(`<script type=text/template>fbq('init', '${PIXEL}');</script>`)).toEqual([]);
  });

  it('ignores a single-quoted non-executable type', () => {
    expect(detectMetaPixels(`<script type='text/x-handlebars'>fbq('init', '${PIXEL}');</script>`)).toEqual([]);
  });

  it('still executes an unquoted executable type', () => {
    expect(detectMetaPixels(`<script type=text/javascript>fbq('init', '${PIXEL}');</script>`)).toEqual([`PIXEL:${PIXEL}`]);
  });
});

/*
 * Greptile P1, round 12. A <script src="…"> element loads the external file and its INLINE
 * content is ignored entirely by the browser — so a pixel snippet written between those tags
 * never runs, no matter what its type says.
 */
describe('detectMetaPixels — external scripts ignore their inline body', () => {
  it('ignores an fbq init inside a script that has a src', () => {
    expect(detectMetaPixels(
      `<script src="/app.js">fbq('init', '${PIXEL}');</script>`,
    )).toEqual([]);
  });

  it('still reads a normal inline script that follows one', () => {
    expect(detectMetaPixels(
      `<script src="/app.js">fbq('init','${OTHER_PIXEL}')</script><script>fbq('init', '${PIXEL}');</script>`,
    )).toEqual([`PIXEL:${PIXEL}`]);
  });
});

/*
 * Greptile P1, round 13. The script-type matcher took the first `type=` SUBSTRING in the
 * attribute string, so metadata containing `type="text/javascript"` shadowed the tag's real
 * `type="text/template"`. Identical shape to the <img src> finding in round 9 — fixed the
 * same way, by walking attributes rather than anchoring inside the raw tag text.
 */
describe('detectMetaPixels — attribute values cannot impersonate the type', () => {
  it('ignores a template script whose metadata mentions an executable type', () => {
    expect(detectMetaPixels(
      `<script data-note='type="text/javascript"' type="text/template">fbq('init', '${PIXEL}');</script>`,
    )).toEqual([]);
  });

  it('ignores one where the impersonating text comes from a src-shaped attribute', () => {
    expect(detectMetaPixels(
      `<script data-doc="type=text/javascript src=x" type=text/x-template>fbq('init','${PIXEL}')</script>`,
    )).toEqual([]);
  });

  it('still executes a real script carrying unrelated metadata', () => {
    expect(detectMetaPixels(
      `<script data-note='type="text/template"' type="text/javascript">fbq('init', '${PIXEL}');</script>`,
    )).toEqual([`PIXEL:${PIXEL}`]);
  });

  it('does not treat a src mentioned inside another attribute as an external script', () => {
    expect(detectMetaPixels(
      `<script data-doc='src="/app.js"'>fbq('init', '${PIXEL}');</script>`,
    )).toEqual([`PIXEL:${PIXEL}`]);
  });
});

/*
 * Greptile P1, round 14. A <script> nested in <noscript> runs only when scripting is
 * DISABLED — i.e. never, for the browsers a paid campaign's traffic arrives in. The fix has
 * to be surgical: <noscript> is also where the legitimate <img> beacon lives, so the
 * container itself cannot be stripped the way <template> and <style> were.
 */
describe('detectMetaPixels — scripts inside noscript never run', () => {
  it('ignores an fbq init inside a noscript-nested script', () => {
    expect(detectMetaPixels(
      `<noscript><script>fbq('init', '${PIXEL}');</script></noscript>`,
    )).toEqual([]);
  });

  it('still counts the beacon image in the same noscript block', () => {
    expect(detectMetaPixels(
      `<noscript><script>fbq('init','${OTHER_PIXEL}')</script>` +
      `<img height="1" width="1" src="https://www.facebook.com/tr?id=${PIXEL}&ev=PageView"/></noscript>`,
    )).toEqual([`PIXEL:${PIXEL}`]);
  });

  it('still reads a real inline script outside the noscript block', () => {
    expect(detectMetaPixels(
      `<noscript><script>fbq('init','${OTHER_PIXEL}')</script></noscript><script>fbq('init','${PIXEL}')</script>`,
    )).toEqual([`PIXEL:${PIXEL}`]);
  });
});
