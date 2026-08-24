/**
 * ENG-1499 — last touch must be able to differ from first touch.
 *
 * For a lander-captured lead it structurally could not. The middleware returned
 * early the moment the first-touch cookie existed, so a returning visitor's later
 * campaign click was never recorded anywhere, and `lastTouch` was stamped equal to
 * `firstTouch` at write time. Any last-touch report on lander traffic therefore
 * showed first-touch numbers, with nothing to indicate it — the failure was silent
 * and the data looked complete.
 *
 * Following eng308.middlewareRuntime: EXECUTE the emitted middleware rather than
 * assert on its source. A string assertion cannot tell you whether a two-visit
 * journey actually produces two different touches, which is the entire claim.
 */

import * as ts from 'typescript';
import { buildLandingPageMiddleware } from '../services/v0Service';

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

function makeReq(url: string, opts: { host?: string; cookies?: Record<string, string>; referer?: string } = {}) {
  const nextUrl = new URL(url);
  const headers = new Map<string, string>();
  if (opts.host) headers.set('host', opts.host);
  if (opts.referer) headers.set('referer', opts.referer);
  return {
    nextUrl: Object.assign(nextUrl, { clone: () => new URL(nextUrl.href) }),
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    cookies: new FakeCookies(opts.cookies || {}),
  };
}

function loadMiddleware(domainMap: Record<string, string> = {}) {
  const src = buildLandingPageMiddleware().replace(/^import .*$/gm, '');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports: any = {};
  // eslint-disable-next-line no-new-func
  new Function('exports', 'NextResponse', 'DOMAIN_MAP', js)(exports, NextResponse, domainMap);
  return exports as { middleware: (req: any) => FakeResponse; config: { matcher: string[] } };
}

const FIRST = 'aw_first_touch';
const LAST = 'aw_last_touch';

describe('ENG-1499 — the emitted middleware, actually executed', () => {
  it('stamps both cookies identically on a first attributed visit', () => {
    const mw = loadMiddleware({});
    const res = mw.middleware(
      makeReq('https://lp.example.com/?utm_source=google&utm_medium=cpc&gclid=G1', { host: 'lp.example.com' }),
    );

    const first = res.cookies.wasSet(FIRST);
    const last = res.cookies.wasSet(LAST);
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    expect(JSON.parse(last!.value).clickIds).toEqual({ gclid: 'G1' });
    // Nothing to distinguish yet — one visit is genuinely both touches.
    expect(last!.value).toBe(first!.value);
  });

  // The whole ticket. Before the fix this returned at the cookie check and set nothing.
  it('records a SECOND campaign click without disturbing the first', () => {
    const mw = loadMiddleware({});
    const firstTouch = JSON.stringify({
      timestamp: '2026-01-01T00:00:00.000Z',
      landingUrl: 'https://lp.example.com/?gclid=ORIGINAL',
      clickIds: { gclid: 'ORIGINAL' },
      utm: { source: 'google', medium: 'cpc' },
    });

    const res = mw.middleware(
      makeReq('https://lp.example.com/?utm_source=meta&utm_medium=paid&fbclid=SECOND', {
        host: 'lp.example.com',
        cookies: { [FIRST]: firstTouch },
      }),
    );

    // first touch is immutable — the acquiring click is not rewritten
    expect(res.cookies.wasSet(FIRST)).toBeUndefined();

    // ...but the return visit is now recorded, which is what was impossible before
    const last = res.cookies.wasSet(LAST);
    expect(last).toBeDefined();
    const parsed = JSON.parse(last!.value);
    expect(parsed.clickIds).toEqual({ fbclid: 'SECOND' });
    expect(parsed.utm).toEqual({ source: 'meta', medium: 'paid' });
    expect(last!.value).not.toBe(firstTouch);
  });

  it('overwrites a previous last touch with the newer one', () => {
    const mw = loadMiddleware({});
    const res = mw.middleware(
      makeReq('https://lp.example.com/?utm_source=bing&gclid=THIRD', {
        host: 'lp.example.com',
        cookies: { [FIRST]: '{"clickIds":{"gclid":"ORIGINAL"}}', [LAST]: '{"clickIds":{"gclid":"SECOND"}}' },
      }),
    );
    expect(JSON.parse(res.cookies.wasSet(LAST)!.value).clickIds).toEqual({ gclid: 'THIRD' });
  });

  // The correctness trap in this fix. If any pageview counted as a touch, browsing
  // to a second page would overwrite a real campaign last-touch with an empty one —
  // turning a merely-useless field into an actively wrong one. Worse than the bug.
  it('does NOT treat an ordinary internal navigation as a touch', () => {
    const mw = loadMiddleware({});
    const res = mw.middleware(
      makeReq('https://lp.example.com/pricing', {
        host: 'lp.example.com',
        cookies: { [FIRST]: '{"clickIds":{"gclid":"ORIGINAL"}}', [LAST]: '{"clickIds":{"fbclid":"SECOND"}}' },
      }),
    );
    expect(res.cookies.wasSet(LAST)).toBeUndefined();
    expect(res.cookies.wasSet(FIRST)).toBeUndefined();
  });

  it('does not let a same-host referrer count as a new touch', () => {
    const mw = loadMiddleware({});
    const res = mw.middleware(
      makeReq('https://lp.example.com/features', {
        host: 'lp.example.com',
        referer: 'https://lp.example.com/',
        cookies: { [FIRST]: '{"clickIds":{"gclid":"ORIGINAL"}}' },
      }),
    );
    expect(res.cookies.wasSet(LAST)).toBeUndefined();
  });

  it('counts an external referrer as a real touch', () => {
    const mw = loadMiddleware({});
    const res = mw.middleware(
      makeReq('https://lp.example.com/', {
        host: 'lp.example.com',
        referer: 'https://news.ycombinator.com/item?id=1',
        cookies: { [FIRST]: '{"clickIds":{"gclid":"ORIGINAL"}}' },
      }),
    );
    const last = res.cookies.wasSet(LAST);
    expect(last).toBeDefined();
    expect(JSON.parse(last!.value).referrer).toContain('ycombinator');
  });

  // ENG-308's lesson: a page with a custom subdomain is the page the customer cared
  // enough to configure. Last touch has to survive the rewrite for the same reason
  // first touch does.
  it('records last touch on the REWRITE path too', () => {
    const mw = loadMiddleware({ 'pricing.acme.com': '/pricing' });
    const res = mw.middleware(
      makeReq('https://pricing.acme.com/?utm_source=google&gclid=REWRITE1', {
        host: 'pricing.acme.com',
        cookies: { [FIRST]: '{"clickIds":{"gclid":"ORIGINAL"}}' },
      }),
    );
    expect(res.kind).toBe('rewrite');
    expect(JSON.parse(res.cookies.wasSet(LAST)!.value).clickIds).toEqual({ gclid: 'REWRITE1' });
  });

  // The interaction between this fix and ENG-308's contract, which I got wrong on
  // the first attempt: firstTouch is deliberately NOT a proxy for "attributed" —
  // direct traffic is a real acquisition channel — so the attributed-only gate must
  // apply to last touch ALONE. Gating both would have silently stopped recording
  // direct-traffic leads entirely.
  it('writes first touch but NOT last touch on an untagged visit', () => {
    const mw = loadMiddleware({});
    const res = mw.middleware(makeReq('https://lp.example.com/', { host: 'lp.example.com' }));

    const first = res.cookies.wasSet(FIRST);
    expect(first).toBeDefined();
    expect(JSON.parse(first!.value).utm).toBeUndefined();
    // No attributed touch has happened yet, so there is nothing to record as "last".
    // The backend falls back to first touch, which is correct for a direct lead.
    expect(res.cookies.wasSet(LAST)).toBeUndefined();
  });

  it('gives a direct-then-campaign visitor a last touch that really differs', () => {
    const mw = loadMiddleware({});
    // visit 1: direct, untagged — acquired by direct traffic
    const v1 = mw.middleware(makeReq('https://lp.example.com/', { host: 'lp.example.com' }));
    const firstTouch = v1.cookies.wasSet(FIRST)!.value;
    expect(JSON.parse(firstTouch).clickIds).toBeUndefined();

    // visit 2: returns on a paid click
    const v2 = mw.middleware(
      makeReq('https://lp.example.com/?utm_source=google&utm_medium=cpc&gclid=RETURN1', {
        host: 'lp.example.com',
        cookies: { [FIRST]: firstTouch },
      }),
    );

    expect(v2.cookies.wasSet(FIRST)).toBeUndefined();          // acquisition unchanged
    const last = JSON.parse(v2.cookies.wasSet(LAST)!.value);
    expect(last.clickIds).toEqual({ gclid: 'RETURN1' });        // and the return is recorded
    expect(last.utm).toEqual({ source: 'google', medium: 'cpc' });
  });

  it('still sets first touch for a visitor who has neither cookie', () => {
    const mw = loadMiddleware({});
    const res = mw.middleware(makeReq('https://lp.example.com/?gclid=NEW', { host: 'lp.example.com' }));
    expect(res.cookies.wasSet(FIRST)).toBeDefined();
    expect(res.cookies.wasSet(LAST)).toBeDefined();
  });
});
