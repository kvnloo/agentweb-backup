/**
 * ENG-309 + ENG-310 — the last link: getting the capture route onto the page.
 *
 * ENG-309: generation skipped capture entirely when no `leadListId` was set — silently,
 *          no error. The page deployed, collected form fills, and attributed nothing.
 * ENG-310: attaching a lead list AFTER generation wrote DynamoDB and nothing else, so
 *          the capture route was never injected. Proven live: a deployed site whose every
 *          page carried a `leadListId` returned 404 on /api/capture.
 *
 * And a third bug the other two were hiding, found while designing the fix:
 *
 *   THE CAPTURE ROUTE IS REPO-LEVEL BUT THE LEAD LIST IS PER-PAGE.
 *   `app/api/capture/route.ts` sits at the repo root — one per SITE — and used to
 *   hardcode a single `const LIST_ID`. But a site has many pages, each with its own
 *   lead list (the test env has four pages in one repo with four different lists). So
 *   the moment capture starts working, leads from three of those four pages would be
 *   filed into the WRONG list. That is strictly worse than today: attribution is
 *   currently missing, and a naive fix would make it wrong. Misfiled leads are far
 *   harder to notice and far worse to explain.
 *
 * So the route is now path-aware, and it resolves the page from a cookie the middleware
 * stamps — NOT from the Referer. Referer is wrong here: ENG-308 means a page can be
 * served at `pricing.acme.com/` and rewritten to `/pricing`, so the browser reports
 * pathname `/` and the lookup misses. The middleware already computed the resolved path,
 * so it stamps it; cookies are always sent same-origin and survive any referrer-policy.
 *
 * A page with no list FAILS LOUDLY rather than falling back to some default list.
 * Misfiling a lead into someone else's list is worse than a visibly failed submit.
 */

import * as ts from 'typescript';
import {
  buildLandingPageMiddleware,
  buildCaptureRoute,
  injectLeadCaptureAttribution,
} from '../services/v0Service';

const srcOf = (files: Array<{ path: string; content: Buffer }>, path: string) => {
  const f = files.find((x) => x.path === path);
  if (!f) throw new Error(`expected ${path} to be emitted`);
  return f.content.toString();
};

// ─── fake next/server, so we can EXECUTE the emitted middleware ───
class FakeCookies {
  private jar = new Map<string, string>();
  private sets: Array<{ name: string; value: string }> = [];
  constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial)) this.jar.set(k, v);
  }
  get(name: string) {
    const v = this.jar.get(name);
    return v === undefined ? undefined : { name, value: v };
  }
  set(name: string, value: string) {
    this.jar.set(name, value);
    this.sets.push({ name, value });
  }
  wasSet(name: string) {
    return this.sets.find((s) => s.name === name);
  }
}
class FakeRes {
  cookies = new FakeCookies();
  constructor(public kind: 'next' | 'rewrite', public to?: string) {}
}
const NextResponse = {
  next: () => new FakeRes('next'),
  rewrite: (u: URL) => new FakeRes('rewrite', u.pathname),
};

function loadMiddleware(domainMap: Record<string, string> = {}) {
  const src = buildLandingPageMiddleware().replace(/^import .*$/gm, '');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exp: any = {};
  // eslint-disable-next-line no-new-func
  new Function('exports', 'NextResponse', 'DOMAIN_MAP', js)(exp, NextResponse, domainMap);
  return exp as { middleware: (req: any) => FakeRes };
}

function makeReq(url: string, host: string, cookies: Record<string, string> = {}) {
  const nextUrl = new URL(url);
  return {
    nextUrl: Object.assign(nextUrl, { clone: () => new URL(nextUrl.href) }),
    headers: { get: (k: string) => (k.toLowerCase() === 'host' ? host : null) },
    cookies: new FakeCookies(cookies),
  };
}

describe('ENG-310 — the middleware stamps the RESOLVED page path', () => {
  it('stamps aw_page with the plain path when there is no rewrite', () => {
    const mw = loadMiddleware({});
    const res = mw.middleware(makeReq('https://lp.com/eng287-alpha', 'lp.com'));
    expect(res.cookies.wasSet('aw_page')?.value).toBe('/eng287-alpha');
  });

  it('stamps the REWRITTEN path, not the requested one — the Referer would be wrong here', () => {
    // THE reason we do not use the Referer header. The browser would report pathname `/`
    // for `pricing.acme.com/`, so a path→list lookup would miss and the lead would be
    // filed against the wrong page's list (or none).
    const mw = loadMiddleware({ 'pricing.acme.com': '/pricing' });
    const res = mw.middleware(makeReq('https://pricing.acme.com/', 'pricing.acme.com'));
    expect(res.kind).toBe('rewrite');
    expect(res.cookies.wasSet('aw_page')?.value).toBe('/pricing');
  });

  it('OVERWRITES aw_page on every request — it is not first-touch', () => {
    // A visitor may land on page A and submit a form on page B. The lead belongs to B's
    // list. `aw_first_touch` is deliberately never overwritten; `aw_page` must be.
    const mw = loadMiddleware({});
    const res = mw.middleware(
      makeReq('https://lp.com/page-b', 'lp.com', { aw_page: '/page-a', aw_first_touch: '{}' }),
    );
    expect(res.cookies.wasSet('aw_page')?.value).toBe('/page-b');
  });

  it('still does not re-stamp aw_first_touch when one exists', () => {
    const mw = loadMiddleware({});
    const res = mw.middleware(
      makeReq('https://lp.com/x?utm_source=second', 'lp.com', { aw_first_touch: '{"utm":{"source":"first"}}' }),
    );
    expect(res.cookies.wasSet('aw_first_touch')).toBeUndefined();
    expect(res.cookies.wasSet('aw_page')?.value).toBe('/x'); // but the page IS updated
  });
});

describe('ENG-310 — the capture route is path-aware (leads must not be misfiled)', () => {
  const MAP = { '/eng287-alpha': 'list_a', '/rankai-book-a-demo': 'list_b', '/': 'list_root' };

  it('carries the whole per-page list map, not one hardcoded LIST_ID', () => {
    const src = buildCaptureRoute(MAP);
    expect(src).toContain('list_a');
    expect(src).toContain('list_b');
    expect(src).toContain('list_root');
    // the old single-list form must be gone
    expect(src).not.toMatch(/const LIST_ID = "[^"]+";/);
  });

  it('resolves the list from the aw_page cookie the middleware stamped', () => {
    const src = buildCaptureRoute(MAP);
    expect(src).toContain('aw_page');
  });

  it('falls back to the Referer path when the cookie is absent', () => {
    const src = buildCaptureRoute(MAP);
    expect(src).toMatch(/referer/i);
  });

  it('FAILS LOUDLY when the page has no list — never guesses a default', () => {
    // Misfiling a lead into someone else's list is much worse than a visibly failed
    // submit. So: no entry for this page => error, not a fallback list.
    const src = buildCaptureRoute(MAP);
    expect(src).toMatch(/no lead list|not configured|422|400/i);
    // and it must not silently pick the first/any list
    expect(src).not.toMatch(/Object\.values\([A-Z_]+\)\[0\]/);
  });

  it('still forwards the first-touch attribution top-level', () => {
    const src = buildCaptureRoute(MAP);
    expect(src).toContain('aw_first_touch');
    expect(src).toContain('attribution');
    expect(src).toContain('/api/webhooks/forward-lead');
  });

  it('ENG-449: captures the real submission time at the top of POST and forwards it, not server CAPI-send time', () => {
    const src = buildCaptureRoute(MAP);
    expect(src).toContain('capturedAtMs');
    expect(src).toContain('Date.now()');
    // Captured BEFORE the request body is even parsed — as close to the real
    // submission moment as this handler can get.
    const capturedIdx = src.indexOf('capturedAtMs = Date.now()');
    const bodyParseIdx = src.indexOf('req.json()');
    expect(capturedIdx).toBeGreaterThan(-1);
    expect(bodyParseIdx).toBeGreaterThan(-1);
    expect(capturedIdx).toBeLessThan(bodyParseIdx);
  });
});

describe('ENG-309 — capture is never silently skipped', () => {
  it('emits middleware and domainMap EVEN WITH NO LEAD LIST', () => {
    // The middleware needs no list — it only sets a cookie. Only the capture ROUTE
    // needs one. Skipping the whole injection because no list was attached is what made
    // a page silently unattributable forever.
    const files = injectLeadCaptureAttribution([], {});
    expect(srcOf(files, 'middleware.ts')).toContain('aw_first_touch');
    expect(srcOf(files, 'domainMap.ts')).toContain('DOMAIN_MAP');
  });

  it('emits the capture route even with an empty map — it fails loudly rather than 404', () => {
    // A missing route gives a bare 404 and no clue. A present route that says "this page
    // has no lead list configured" is debuggable.
    const files = injectLeadCaptureAttribution([], {});
    const route = srcOf(files, 'app/api/capture/route.ts');
    expect(route).toMatch(/no lead list|not configured/i);
  });

  it('wires every page of the site into the route when lists exist', () => {
    const files = injectLeadCaptureAttribution([], {
      '/a': 'list_a',
      '/b': 'list_b',
    });
    const route = srcOf(files, 'app/api/capture/route.ts');
    expect(route).toContain('list_a');
    expect(route).toContain('list_b');
  });

  it('drops v0-generated middleware / domainMap / capture route so ours are authoritative', () => {
    const files = injectLeadCaptureAttribution(
      [
        { path: 'middleware.ts', content: Buffer.from('// v0') },
        { path: 'domainMap.ts', content: Buffer.from('// v0') },
        { path: 'app/api/capture/route.ts', content: Buffer.from('// v0') },
      ],
      { '/': 'list_root' },
    );
    expect(srcOf(files, 'middleware.ts')).not.toContain('// v0');
    expect(srcOf(files, 'app/api/capture/route.ts')).not.toContain('// v0');
    for (const p of ['middleware.ts', 'domainMap.ts', 'app/api/capture/route.ts']) {
      expect(files.filter((f) => f.path === p)).toHaveLength(1);
    }
  });
});

describe('the shape guard', () => {
  it('rejects the OLD string form loudly instead of emitting a broken route', () => {
    // Passing the pre-ENG-310 `leadListId: string` produced
    //   const LIST_BY_PATH: Record<string,string> = "list_xyz";
    // — a route that compiles, deploys, and files every lead nowhere. ts-jest did not
    // catch it. Fail here rather than shipping that to a customer's site.
    // @ts-expect-error — exercising the runtime guard, not the type
    expect(() => buildCaptureRoute('list_xyz')).toThrow(/path->leadListId map/i);
    // @ts-expect-error
    expect(() => buildCaptureRoute(null)).toThrow(/path->leadListId map/i);
    // @ts-expect-error
    expect(() => buildCaptureRoute(['/a'])).toThrow(/path->leadListId map/i);
  });
});
