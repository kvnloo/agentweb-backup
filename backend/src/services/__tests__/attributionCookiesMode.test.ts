import ts from 'typescript';
import { buildLandingPageMiddleware, PLATFORM_MIDDLEWARE_MARKER, CONSENT_COOKIE_NAME } from '../v0Service';
import { detectCaptureDrift } from '../captureDriftDetector';

// ENG-2666: per-site attributionCookies mode for the generated LP middleware.

type Cookie = { name: string; value: string };

function run(source: string, opts: { url: string; cookies?: Record<string, string> }): Cookie[] {
  const js = ts.transpileModule(
    source.replace(/^import .*$/gm, ''),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
  ).outputText;
  const set: Cookie[] = [];
  const makeRes = () => ({ cookies: { set: (name: string, value: string) => set.push({ name, value }) } });
  const NextResponse = { next: makeRes, rewrite: makeRes };
  const url = new URL(opts.url);
  const req = {
    headers: { get: (h: string) => (h === 'host' ? url.host : null) },
    nextUrl: { pathname: url.pathname, searchParams: url.searchParams, href: url.href, host: url.host, clone: () => ({ ...url }) },
    cookies: { get: (n: string) => (opts.cookies?.[n] !== undefined ? { value: opts.cookies[n] } : undefined) },
  };
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'NextResponse', 'DOMAIN_MAP', js)(mod, mod.exports, NextResponse, {});
  (mod.exports.middleware as (r: unknown) => unknown)(req);
  return set;
}

const names = (c: Cookie[]) => c.map((x) => x.name).sort();
const TAGGED = 'https://lp.example.com/?gclid=test&utm_source=google';

describe('buildLandingPageMiddleware attributionCookies (ENG-2666)', () => {
  it("default and explicit 'on' are byte-identical", () => {
    expect(buildLandingPageMiddleware({ attributionCookies: 'on' })).toBe(buildLandingPageMiddleware());
    expect(buildLandingPageMiddleware({})).toBe(buildLandingPageMiddleware());
  });

  it("'on' sets aw_page, aw_first_touch, aw_last_touch", () => {
    expect(names(run(buildLandingPageMiddleware(), { url: TAGGED }))).toEqual(['aw_first_touch', 'aw_last_touch', 'aw_page']);
  });

  it("'off' keeps aw_page only, even with a consent cookie", () => {
    const src = buildLandingPageMiddleware({ attributionCookies: 'off' });
    expect(names(run(src, { url: TAGGED }))).toEqual(['aw_page']);
    expect(names(run(src, { url: TAGGED, cookies: { [CONSENT_COOKIE_NAME]: 'granted' } }))).toEqual(['aw_page']);
  });

  it("'consent' sets attribution cookies only when consent is granted", () => {
    const src = buildLandingPageMiddleware({ attributionCookies: 'consent' });
    expect(names(run(src, { url: TAGGED }))).toEqual(['aw_page']);
    expect(names(run(src, { url: TAGGED, cookies: { [CONSENT_COOKIE_NAME]: 'denied' } }))).toEqual(['aw_page']);
    expect(names(run(src, { url: TAGGED, cookies: { [CONSENT_COOKIE_NAME]: 'granted' } }))).toEqual([
      'aw_first_touch',
      'aw_last_touch',
      'aw_page',
    ]);
  });

  it('every mode still carries the platform marker so syncs keep ownership', () => {
    for (const m of ['on', 'off', 'consent'] as const) {
      expect(buildLandingPageMiddleware({ attributionCookies: m })).toContain(PLATFORM_MIDDLEWARE_MARKER);
    }
  });
});

describe('detectCaptureDrift with attributionCookies (ENG-2666)', () => {
  const off = buildLandingPageMiddleware({ attributionCookies: 'off' });
  it("an 'off' site serving the 'off' middleware is not drifted", () => {
    const r = detectCaptureDrift({ middleware: off, captureRoute: null, attributionCookies: 'off' });
    expect(r.files[0].status).toBe('match');
  });
  it("an 'off' middleware on an 'on' (default) site is drifted", () => {
    expect(detectCaptureDrift({ middleware: off, captureRoute: null }).files[0].status).toBe('drifted');
  });
  it("default 'on' middleware still matches with no mode", () => {
    expect(detectCaptureDrift({ middleware: buildLandingPageMiddleware(), captureRoute: null }).files[0].status).toBe('match');
  });
});
