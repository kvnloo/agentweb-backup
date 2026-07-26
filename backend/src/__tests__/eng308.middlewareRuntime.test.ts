/**
 * ENG-308 — EXECUTE the emitted middleware, don't just assert on its source.
 *
 * `eng308.middlewareClobber.test.ts` asserts on the middleware STRING. That is
 * necessary (the string is literally what gets committed to the customer's repo) but
 * it is not sufficient: a string assertion cannot tell you whether the thing actually
 * *behaves*. The matcher regression — excluding a bare `api` instead of `api/`, which
 * would have stripped the middleware from real page routes like /api-docs and visibly
 * broken those customer pages — slipped straight past the string tests.
 *
 * So this suite takes the exact source `buildLandingPageMiddleware()` emits,
 * transpiles it, and RUNS it against a fake `next/server`. It targets the two failure
 * modes that would silently destroy attribution in production:
 *
 *   1. Capture must survive the REWRITE path. A page with a custom subdomain is
 *      precisely the page a customer cared enough about to configure — if the rewrite
 *      early-returned, attribution would work everywhere except where it mattered.
 *   2. `NextResponse.rewrite()` must actually accept a cookie write. If it did not,
 *      the merged middleware would be silently useless on every domain-attached page,
 *      which is the exact bug ENG-308 is fixing.
 */

import * as ts from 'typescript';
import { buildLandingPageMiddleware, buildDomainMapFile } from '../services/v0Service';

// ─── a faithful-enough fake of the bits of next/server the middleware touches ───

class FakeCookies {
  private jar = new Map<string, string>();
  private setCalls: Array<{ name: string; value: string; opts: any }> = [];
  constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial)) this.jar.set(k, v);
  }
  get(name: string) {
    const v = this.jar.get(name);
    return v === undefined ? undefined : { name, value: v };
  }
  set(name: string, value: string, opts: any = {}) {
    this.jar.set(name, value);
    this.setCalls.push({ name, value, opts });
  }
  wasSet(name: string) {
    return this.setCalls.find((c) => c.name === name);
  }
}

class FakeResponse {
  cookies = new FakeCookies();
  constructor(public kind: 'next' | 'rewrite', public rewrittenTo?: string) {}
}

const NextResponse = {
  next: () => new FakeResponse('next'),
  rewrite: (url: URL) => new FakeResponse('rewrite', url.pathname),
};

/** Build a NextRequest-alike. */
function makeReq(
  url: string,
  opts: { host?: string; cookie?: string; referer?: string; secFetchDest?: string } = {}
) {
  const nextUrl = new URL(url);
  const headers = new Map<string, string>();
  if (opts.host) headers.set('host', opts.host);
  if (opts.referer) headers.set('referer', opts.referer);
  if (opts.secFetchDest !== undefined) headers.set('sec-fetch-dest', opts.secFetchDest);
  return {
    nextUrl: Object.assign(nextUrl, { clone: () => new URL(nextUrl.href) }),
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    cookies: new FakeCookies(opts.cookie ? { aw_first_touch: opts.cookie } : {}),
  };
}

/** Transpile + evaluate the REAL emitted middleware, wired to the fakes above. */
function loadMiddleware(domainMap: Record<string, string> = {}) {
  const src = buildLandingPageMiddleware()
    // strip the module imports; we inject NextResponse/DOMAIN_MAP directly
    .replace(/^import .*$/gm, '');

  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;

  const exports: any = {};
  // eslint-disable-next-line no-new-func
  new Function('exports', 'NextResponse', 'DOMAIN_MAP', js)(exports, NextResponse, domainMap);
  return exports as {
    middleware: (req: any) => FakeResponse;
    config: { matcher: string[] };
  };
}

const COOKIE = 'aw_first_touch';

describe('ENG-308 — the emitted middleware, actually executed', () => {
  describe('capture on the PLAIN path (no subdomain mapping)', () => {
    it('sets the first-touch cookie with the UTMs from the ad click', () => {
      const mw = loadMiddleware({});
      const res = mw.middleware(
        makeReq('https://lp.example.com/?utm_source=meta&utm_medium=paid&utm_campaign=123&utm_content=456', {
          host: 'lp.example.com',
        }),
      );

      expect(res.kind).toBe('next');
      const set = res.cookies.wasSet(COOKIE);
      expect(set).toBeDefined();
      const touch = JSON.parse(set!.value);
      expect(touch.utm).toEqual({ source: 'meta', medium: 'paid', campaign: '123', content: '456' });
      expect(touch.landingUrl).toContain('utm_source=meta');
      expect(set!.opts.maxAge).toBe(60 * 60 * 24 * 90);
    });

    it('captures ad-platform click ids', () => {
      const mw = loadMiddleware({});
      const res = mw.middleware(makeReq('https://lp.example.com/?fbclid=FB1&gclid=G1', { host: 'lp.example.com' }));
      const touch = JSON.parse(res.cookies.wasSet(COOKIE)!.value);
      expect(touch.clickIds).toEqual({ gclid: 'G1', fbclid: 'FB1' });
    });
  });

  describe('capture on the REWRITE path — THE BUG ENG-308 IS ABOUT', () => {
    it('STILL sets the first-touch cookie when the host maps to a subdomain path', () => {
      // A page with a custom subdomain is exactly the page the customer cared enough
      // to configure. Before ENG-308, attaching that subdomain overwrote the capture
      // middleware entirely and attribution died here — silently.
      const mw = loadMiddleware({ 'pricing.acme.com': '/pricing' });

      const res = mw.middleware(
        makeReq('https://pricing.acme.com/?utm_source=google&utm_medium=paid&utm_campaign=c9', {
          host: 'pricing.acme.com',
        }),
      );

      // the rewrite happened...
      expect(res.kind).toBe('rewrite');
      expect(res.rewrittenTo).toBe('/pricing');

      // ...AND capture survived it
      const set = res.cookies.wasSet(COOKIE);
      expect(set).toBeDefined();
      const touch = JSON.parse(set!.value);
      expect(touch.utm).toEqual({ source: 'google', medium: 'paid', campaign: 'c9' });
    });

    it('rewrites to the mapped path and ignores unmapped hosts', () => {
      const mw = loadMiddleware({ 'pricing.acme.com': '/pricing' });
      const mapped = mw.middleware(makeReq('https://pricing.acme.com/', { host: 'pricing.acme.com' }));
      const unmapped = mw.middleware(makeReq('https://other.acme.com/', { host: 'other.acme.com' }));
      expect(mapped.kind).toBe('rewrite');
      expect(unmapped.kind).toBe('next');
    });

    it('strips the port from the host before looking it up', () => {
      const mw = loadMiddleware({ 'pricing.acme.com': '/pricing' });
      const res = mw.middleware(makeReq('https://pricing.acme.com/', { host: 'pricing.acme.com:3000' }));
      expect(res.kind).toBe('rewrite');
    });
  });

  describe('first-touch semantics', () => {
    it('never overwrites an existing cookie — even on the rewrite path', () => {
      const mw = loadMiddleware({ 'pricing.acme.com': '/pricing' });
      const res = mw.middleware(
        makeReq('https://pricing.acme.com/?utm_source=second', {
          host: 'pricing.acme.com',
          cookie: JSON.stringify({ utm: { source: 'first' } }),
        }),
      );
      expect(res.kind).toBe('rewrite'); // still routes correctly
      expect(res.cookies.wasSet(COOKIE)).toBeUndefined(); // but does not re-stamp
    });

    it('still records a touch for an UNTAGGED visit (direct traffic is a real channel)', () => {
      // NB: this is why `firstTouch` is not a proxy for "attributed" — see
      // LeadAttributionFields in utils/leadSchema.ts.
      const mw = loadMiddleware({});
      const res = mw.middleware(makeReq('https://lp.example.com/', { host: 'lp.example.com' }));
      const touch = JSON.parse(res.cookies.wasSet(COOKIE)!.value);
      expect(touch.timestamp).toBeDefined();
      expect(touch.landingUrl).toBeDefined();
      expect(touch.utm).toBeUndefined(); // <- no attribution, correctly
    });

    it('records an external referrer but not a self-referral', () => {
      const mw = loadMiddleware({});
      const ext = mw.middleware(
        makeReq('https://lp.example.com/', { host: 'lp.example.com', referer: 'https://news.ycombinator.com/' }),
      );
      expect(JSON.parse(ext.cookies.wasSet(COOKIE)!.value).referrer).toBe('https://news.ycombinator.com/');

      const self = mw.middleware(
        makeReq('https://lp.example.com/b', { host: 'lp.example.com', referer: 'https://lp.example.com/a' }),
      );
      expect(JSON.parse(self.cookies.wasSet(COOKIE)!.value).referrer).toBeUndefined();
    });
  });

  describe('sub-resource requests must NOT clobber aw_page/aw_first_touch (live-repro: /placeholder.svg)', () => {
    // The middleware matcher (below) cannot practically exclude every static asset path a
    // generated page might reference (v0's own placeholder images, uploaded photos, fonts —
    // arbitrary paths, not just a fixed extension list). Before this fix, an asset request
    // for e.g. /placeholder.svg matched the SAME catch-all and re-stamped aw_page with
    // "/placeholder.svg" — silently misfiling the NEXT lead submitted from that page into no
    // list at all ("This page has no lead list configured"). Live-repro'd exactly this
    // against a real generated page whose hero section referenced a placeholder image.
    it('a browser sub-resource request (Sec-Fetch-Dest: image) does NOT stamp aw_page', () => {
      const mw = loadMiddleware({});
      const res = mw.middleware(
        makeReq('https://lp.example.com/placeholder.svg', { host: 'lp.example.com', secFetchDest: 'image' })
      );
      expect(res.cookies.wasSet('aw_page')).toBeUndefined();
    });

    it('a browser sub-resource request does NOT stamp aw_first_touch either', () => {
      const mw = loadMiddleware({});
      const res = mw.middleware(
        makeReq('https://lp.example.com/placeholder.svg?utm_source=meta', { host: 'lp.example.com', secFetchDest: 'image' })
      );
      expect(res.cookies.wasSet(COOKIE)).toBeUndefined();
    });

    it('a sub-resource request on the REWRITE path still gets routed correctly (rewrite unaffected)', () => {
      const mw = loadMiddleware({ 'pricing.acme.com': '/pricing' });
      const res = mw.middleware(
        makeReq('https://pricing.acme.com/placeholder.svg', { host: 'pricing.acme.com', secFetchDest: 'image' })
      );
      expect(res.kind).toBe('rewrite');
      expect(res.cookies.wasSet('aw_page')).toBeUndefined();
    });

    it('a real page navigation (Sec-Fetch-Dest: document) still stamps aw_page normally', () => {
      const mw = loadMiddleware({});
      const res = mw.middleware(
        makeReq('https://lp.example.com/pricing', { host: 'lp.example.com', secFetchDest: 'document' })
      );
      expect(res.cookies.wasSet('aw_page')!.value).toBe('/pricing');
    });

    it('permissive default: a request with NO Sec-Fetch-Dest header (old browser, curl, test tooling) still stamps aw_page — never MORE restrictive than before this fix', () => {
      const mw = loadMiddleware({});
      const res = mw.middleware(makeReq('https://lp.example.com/pricing', { host: 'lp.example.com' }));
      expect(res.cookies.wasSet('aw_page')!.value).toBe('/pricing');
    });

    // A page embedded in an iframe (widget embed, agency preview tool, AB-test wrapper) is
    // still a REAL page being loaded for a visitor to view and submit a form on — just nested,
    // not top-level. Its Sec-Fetch-Dest is "iframe"/"frame", not "document", but it must NOT
    // be treated as a sub-resource: doing so would silently degrade attribution for embedded
    // pages to the weaker Referer-based fallback (the exact problem the aw_page cookie exists
    // to avoid on a rewritten custom-domain host).
    it('a page loaded inside an iframe (Sec-Fetch-Dest: iframe) STILL stamps aw_page — it is a real page view, not a sub-resource', () => {
      const mw = loadMiddleware({});
      const res = mw.middleware(
        makeReq('https://lp.example.com/pricing', { host: 'lp.example.com', secFetchDest: 'iframe' })
      );
      expect(res.cookies.wasSet('aw_page')!.value).toBe('/pricing');
    });

    it('a page loaded inside a legacy <frame> (Sec-Fetch-Dest: frame) STILL stamps aw_page', () => {
      const mw = loadMiddleware({});
      const res = mw.middleware(
        makeReq('https://lp.example.com/pricing', { host: 'lp.example.com', secFetchDest: 'frame' })
      );
      expect(res.cookies.wasSet('aw_page')!.value).toBe('/pricing');
    });
  });

  describe('the matcher, as Next.js would apply it', () => {
    it('excludes /api/* but keeps page routes that merely start with "api"', () => {
      const { config } = loadMiddleware({});
      const re = new RegExp(`^${config.matcher[0]}$`);

      expect(re.test('/api/capture')).toBe(false); // reads the cookie — must not be rewritten
      expect(re.test('/api-docs')).toBe(true); // a real page — must still route
      expect(re.test('/apis')).toBe(true);
      expect(re.test('/')).toBe(true);
      expect(re.test('/pricing')).toBe(true);
    });
  });
});

describe('ENG-308 — the emitted domainMap compiles and exports what the middleware imports', () => {
  it('emits a valid TS module exporting DOMAIN_MAP', () => {
    const js = ts.transpileModule(buildDomainMapFile({ 'a.com': '/a' }), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const exports: any = {};
    // eslint-disable-next-line no-new-func
    new Function('exports', js)(exports);
    expect(exports.DOMAIN_MAP).toEqual({ 'a.com': '/a' });
  });

  it('an empty map (what a freshly generated page ships) is still a valid module', () => {
    const js = ts.transpileModule(buildDomainMapFile({}), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const exports: any = {};
    // eslint-disable-next-line no-new-func
    new Function('exports', js)(exports);
    expect(exports.DOMAIN_MAP).toEqual({});
  });
});
