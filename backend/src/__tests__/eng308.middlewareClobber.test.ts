/**
 * ENG-308 — the subdomain middleware silently overwrites the lead-capture middleware.
 *
 * Next.js allows exactly ONE `middleware.ts` at the repo root. Two writers were
 * emitting it, and neither knew the other existed:
 *
 *   - `injectLeadCaptureAttribution` writes the LEAD-CAPTURE middleware at generation
 *     (stamps the `aw_first_touch` cookie from utm_* / gclid / fbclid). This is the
 *     entire client-side half of attribution.
 *   - `updateSubdomainMiddleware` writes a SUBDOMAIN-ROUTING middleware to the same
 *     path on any domain attach/detach, via a GitHub git-tree write that REPLACES
 *     that path's blob. It carried zero capture logic.
 *
 * So: generate a page (gets capture) → attach a subdomain to make it publicly
 * addressable → capture is destroyed, permanently and silently. Attribution for that
 * page is dead until it is regenerated.
 *
 * The fix is ONE canonical middleware that does BOTH jobs, emitted by BOTH writers.
 * These tests pin that: neither writer may produce a middleware missing the other's
 * behaviour. They are string-level assertions on the emitted source because that
 * source is what gets committed to the customer's repo — there is nothing else to
 * assert against.
 */

import {
  buildLandingPageMiddleware,
  injectLeadCaptureAttribution,
  MIDDLEWARE_CONTENT,
} from '../services/v0Service';

const fileNamed = (files: Array<{ path: string; content: Buffer }>, path: string) =>
  files.find((f) => f.path === path);

const srcOf = (files: Array<{ path: string; content: Buffer }>, path: string) => {
  const f = fileNamed(files, path);
  if (!f) throw new Error(`expected ${path} to be emitted`);
  return f.content.toString();
};

/** The two behaviours that must coexist in ANY middleware we ship. */
function assertDoesSubdomainRewrite(src: string) {
  expect(src).toMatch(/DOMAIN_MAP/);
  expect(src).toMatch(/NextResponse\.rewrite/);
  expect(src).toContain('from "./domainMap"');
}

function assertDoesFirstTouchCapture(src: string) {
  expect(src).toContain('aw_first_touch');

  // The middleware builds its keys dynamically — `sp.get("utm_" + k)` over a literal
  // array of suffixes — so the string `utm_source` never appears in the source. Assert
  // on what IS there: every one of the five suffixes, AND the `utm_` prefixing that
  // turns them into the real param names. (Asserting `toContain('"utm_" + k')` five
  // times, as this once did, is a no-op: it checks the same fixed string each pass and
  // would still pass if the array had lost three of its keys. The runtime suite proves
  // the behaviour; this one must at least pin the key list.)
  for (const k of ['source', 'medium', 'campaign', 'content', 'term']) {
    expect(src).toContain(`"${k}"`);
  }
  expect(src).toContain('"utm_" + k');

  // and the ad-platform click ids
  for (const id of ['gclid', 'fbclid', 'ttclid', 'li_fat_id']) {
    expect(src).toContain(id);
  }
  expect(src).toMatch(/cookies\.set\(/);
}

describe('ENG-308 — one middleware, both jobs', () => {
  describe('the canonical template', () => {
    const src = buildLandingPageMiddleware();

    it('performs the subdomain rewrite', () => {
      assertDoesSubdomainRewrite(src);
    });

    it('performs the first-touch capture', () => {
      assertDoesFirstTouchCapture(src);
    });

    it('sets the cookie on the SAME response it returns, on BOTH paths', () => {
      // The bug class this guards: doing the rewrite with an early `return`, so the
      // capture never runs for any host that has a subdomain mapping — i.e. exactly
      // the pages a customer has bothered to give a domain to.
      const rewriteIdx = src.indexOf('NextResponse.rewrite');
      const cookieIdx = src.indexOf('cookies.set(');
      expect(rewriteIdx).toBeGreaterThan(-1);
      expect(cookieIdx).toBeGreaterThan(-1);
      // the cookie write must come AFTER the response is chosen, not inside an
      // early-return branch that skips it
      expect(cookieIdx).toBeGreaterThan(rewriteIdx);
      expect(src).not.toMatch(/return NextResponse\.rewrite\([^)]*\);\s*\n\s*\}/);
    });

    it('never runs on /api/* — the capture route reads the cookie, it must not be rewritten', () => {
      expect(src).toMatch(/matcher/);
      expect(src).toMatch(/api/);
    });

    it('EXCLUDES only "api/" — a page route merely STARTING with "api" must still work', () => {
      // The two middlewares this replaces did NOT agree here: the capture one excluded
      // `api` (no slash), the subdomain one excluded `api/`. Unifying on the former
      // would strip the middleware from routes like /api-docs, /apis, /api-integration
      // — which are entirely plausible B2B landing pages — and those pages would lose
      // their SUBDOMAIN REWRITE, i.e. visibly break for the customer. Only `/api/*`
      // may be excluded.
      const matcher = src.match(/matcher:\s*\[\s*"([^"]+)"/)?.[1];
      expect(matcher).toBeDefined();
      const re = new RegExp(`^${matcher}$`);

      // must NOT match (the capture route must never be rewritten)
      expect(re.test('/api/capture')).toBe(false);
      expect(re.test('/api/anything')).toBe(false);

      // MUST still match (real page routes that merely begin with the letters "api")
      expect(re.test('/api-docs')).toBe(true);
      expect(re.test('/apis')).toBe(true);
      expect(re.test('/api-integration')).toBe(true);

      // and the ordinary cases
      expect(re.test('/')).toBe(true);
      expect(re.test('/pricing')).toBe(true);
    });

    it('is first-touch: an existing cookie is never overwritten', () => {
      expect(src).toMatch(/cookies\.get\(COOKIE\)/);
    });
  });

  describe('writer 1 — injectLeadCaptureAttribution (generation)', () => {
    const files = injectLeadCaptureAttribution([], { '/': 'list_abc' });

    it('emits a middleware that ALSO does the subdomain rewrite', () => {
      // Before ENG-308 this middleware had no rewrite at all, so a later domain
      // operation had to replace it wholesale — which is what destroyed capture.
      assertDoesSubdomainRewrite(srcOf(files, 'middleware.ts'));
    });

    it('still emits the capture middleware and the capture route', () => {
      assertDoesFirstTouchCapture(srcOf(files, 'middleware.ts'));
      expect(srcOf(files, 'app/api/capture/route.ts')).toContain('list_abc');
    });

    it('emits a domainMap.ts so the merged middleware compiles on a fresh page', () => {
      // The merged middleware imports ./domainMap. Generation never emitted one, so
      // without this the very first Vercel build of every new page would fail.
      const src = srcOf(files, 'domainMap.ts');
      expect(src).toContain('DOMAIN_MAP');
      expect(src).toMatch(/\{\s*\}/); // empty map — no subdomains attached yet
    });

    it('emits exactly one middleware.ts and one domainMap.ts', () => {
      expect(files.filter((f) => f.path === 'middleware.ts')).toHaveLength(1);
      expect(files.filter((f) => f.path === 'domainMap.ts')).toHaveLength(1);
    });

    it('drops any v0-generated middleware/domainMap so ours is authoritative', () => {
      const withV0 = injectLeadCaptureAttribution(
        [
          { path: 'middleware.ts', content: Buffer.from('// v0 middleware') },
          { path: 'domainMap.ts', content: Buffer.from('// v0 domainMap') },
        ],
        { '/': 'list_abc' },
      );
      expect(srcOf(withV0, 'middleware.ts')).not.toContain('v0 middleware');
      expect(withV0.filter((f) => f.path === 'middleware.ts')).toHaveLength(1);
      expect(withV0.filter((f) => f.path === 'domainMap.ts')).toHaveLength(1);
    });
  });

  describe('writer 2 — MIDDLEWARE_CONTENT (domain attach/detach)', () => {
    it('emits a middleware that ALSO does the first-touch capture', () => {
      // THE REGRESSION THIS FILE EXISTS FOR. This constant is committed over the
      // top of the generated middleware.ts on every domain operation. If it lacks
      // capture, attaching a subdomain silently destroys attribution.
      assertDoesFirstTouchCapture(MIDDLEWARE_CONTENT);
    });

    it('still performs the subdomain rewrite', () => {
      assertDoesSubdomainRewrite(MIDDLEWARE_CONTENT);
    });

    it('is byte-identical to what generation emits — one template, no drift', () => {
      // The only real guarantee that these two can never diverge again.
      const generated = srcOf(injectLeadCaptureAttribution([], { '/': 'list_x' }), 'middleware.ts');
      expect(MIDDLEWARE_CONTENT).toBe(generated);
      expect(MIDDLEWARE_CONTENT).toBe(buildLandingPageMiddleware());
    });
  });

  describe('the clobber itself', () => {
    it('overwriting the generated middleware with the subdomain one preserves capture', () => {
      // Simulate exactly what updateSubdomainMiddleware does to a freshly generated
      // repo: replace middleware.ts wholesale. Capture must survive.
      const generated = srcOf(injectLeadCaptureAttribution([], { '/': 'list_abc' }), 'middleware.ts');
      assertDoesFirstTouchCapture(generated);

      const afterDomainAttach = MIDDLEWARE_CONTENT; // what gets committed over it

      assertDoesFirstTouchCapture(afterDomainAttach); // <- was the bug
      assertDoesSubdomainRewrite(afterDomainAttach);
    });
  });
});
