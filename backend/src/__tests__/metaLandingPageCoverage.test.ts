/**
 * ENG-926 §G — generated-landing-page coverage, the card's sixth check.
 *
 * The population this covers that #2448 cannot: a DEPLOYED lander with no ACTIVE ad pointing
 * at it. #2448 only ever inspects a page an ad sends paid traffic to, so the page nobody is
 * launching at today — the one most likely to be assumed instrumented because we built it —
 * was checked by nothing.
 *
 * Identifiers are synthetic.
 */

import {
  collectSitesToCheck,
  evaluateLandingPageCoverage,
  shouldCheckSiteToday,
  MAX_SITES_CHECKED,
  SITE_ROTATION_DAYS,
} from '../services/metaLandingPageCoverage';

/** A date on which the given site id IS due, so rotation never makes a test flaky. */
const dueDateFor = (siteId: string): Date => {
  for (let d = 0; d < SITE_ROTATION_DAYS * 2; d++) {
    const when = new Date(Date.UTC(2026, 7, 19) + d * 86_400_000);
    if (shouldCheckSiteToday(siteId, when)) return when;
  }
  throw new Error(`no due date found for ${siteId}`);
};

const page = (over: any = {}) => ({
  id: 'p1', userId: 'u1', name: 'Lander', status: 'deployed',
  deployedUrl: 'https://site-a.test/', ...over,
});

describe('collectSitesToCheck', () => {
  it('checks ONE page per site — the pixel lives in the shared layout', () => {
    // §22: asking a single record "do you have a pixel?" reported 9 of one customer's 10
    // pages as untracked while the whole site was fine. Per-site is both correct and cheap.
    const { sites } = collectSitesToCheck([
      page({ id: 'root', siteId: 'root', isRootPage: true, deployedUrl: 'https://s.test/' }),
      page({ id: 'sub1', siteId: 'root', deployedUrl: 'https://s.test/a' }),
      page({ id: 'sub2', siteId: 'root', deployedUrl: 'https://s.test/b' }),
    ], dueDateFor('root'));
    expect(sites).toHaveLength(1);
    expect(sites[0].pageId).toBe('root');
  });

  it('prefers the root record over a sub-page', () => {
    const { sites } = collectSitesToCheck([
      page({ id: 'sub', siteId: 'root', createdAt: '2026-01-01' }),
      page({ id: 'root', siteId: 'root', isRootPage: true, createdAt: '2026-06-01' }),
    ], dueDateFor('root'));
    expect(sites[0].pageId).toBe('root');
  });

  it('treats a page whose id IS its siteId as the root', () => {
    const { sites } = collectSitesToCheck([
      page({ id: 'sub', siteId: 'alpha', createdAt: '2026-01-01' }),
      page({ id: 'alpha', siteId: 'alpha', createdAt: '2026-06-01' }),
    ], dueDateFor('alpha'));
    expect(sites[0].pageId).toBe('alpha');
  });

  it('skips pages that are not DEPLOYED', () => {
    // A draft or failed generation serves nothing; calling it uninstrumented would be an
    // accusation about a page nobody can visit.
    for (const status of ['draft', 'generating', 'deploying', 'failed']) {
      expect(collectSitesToCheck([page({ status })], dueDateFor('p1')).sites).toHaveLength(0);
    }
  });

  it('skips a deployed page with no URL at all', () => {
    expect(collectSitesToCheck([page({ deployedUrl: '', customDomainUrl: '' })], dueDateFor('p1')).sites).toHaveLength(0);
  });

  it('prefers customDomainUrl over deployedUrl', () => {
    const { sites } = collectSitesToCheck([
      page({ deployedUrl: 'https://x.vercel.app/', customDomainUrl: 'https://real.test/' }),
    ], dueDateFor('p1'));
    expect(sites[0].url).toBe('https://real.test/');
  });

  it('caps, and REPORTS what it did not check rather than truncating silently', () => {
    const many = Array.from({ length: MAX_SITES_CHECKED + 7 }, (_, i) =>
      page({ id: `p${i}`, siteId: `site${String(i).padStart(3, '0')}`, deployedUrl: `https://s${i}.test/` }));
    // Rotation is applied first, so build a population that is entirely due today.
    const when = new Date(Date.UTC(2026, 7, 19));
    const due = many.filter((p) => shouldCheckSiteToday(String(p.siteId), when));
    const { sites, sitesNotChecked } = collectSitesToCheck(due, when);
    expect(sites.length).toBeLessThanOrEqual(MAX_SITES_CHECKED);
    expect(sites.length + sitesNotChecked).toBe(due.length);
  });

  it('is deterministic, so a cap truncates the same set each run', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      page({ id: `p${i}`, siteId: `site${i}`, deployedUrl: `https://s${i}.test/` }));
    const when = new Date(Date.UTC(2026, 7, 19));
    const a = collectSitesToCheck(many, when).sites.map((s) => s.siteId);
    const b = collectSitesToCheck([...many].reverse(), when).sites.map((s) => s.siteId);
    expect(a).toEqual(b);
  });

  it('tolerates null/garbage input', () => {
    expect(collectSitesToCheck(null).sites).toEqual([]);
    expect(collectSitesToCheck(undefined).sites).toEqual([]);
    expect(collectSitesToCheck([null as any, undefined as any]).sites).toEqual([]);
  });
});

describe('evaluateLandingPageCoverage', () => {
  const site = { siteId: 's1', pageId: 'p1', pageName: 'Lander', url: 'https://s.test/' };

  it('alerts when the served page carries no pixel', () => {
    const v = evaluateLandingPageCoverage(
      [site], { 'https://s.test/': { status: 'unmeasured', detectedPixelIds: [] } }, ['999'],
    );
    expect(v.alerting).toHaveLength(1);
    expect(v.alerting[0].reason).toBe('no_pixel');
  });

  it('alerts on a pixel the paying account does NOT own', () => {
    // A naive "is there any tracking?" check passes this. Ownership is the test.
    const v = evaluateLandingPageCoverage(
      [site], { 'https://s.test/': { status: 'measured', detectedPixelIds: ['111'] } }, ['999'],
    );
    expect(v.alerting[0].reason).toBe('foreign_pixel');
    expect(v.alerting[0].detectedPixelIds).toEqual(['111']);
  });

  it('stays silent when the account owns a detected pixel', () => {
    const v = evaluateLandingPageCoverage(
      [site], { 'https://s.test/': { status: 'measured', detectedPixelIds: ['999'] } }, ['999'],
    );
    expect(v.alerting).toHaveLength(0);
    expect(v.okCount).toBe(1);
  });

  it('is satisfied when ANY detected pixel is owned', () => {
    const v = evaluateLandingPageCoverage(
      [site], { 'https://s.test/': { status: 'measured', detectedPixelIds: ['111', '999'] } }, ['999'],
    );
    expect(v.okCount).toBe(1);
    expect(v.alerting).toHaveLength(0);
  });

  it('an account owning NO pixels yields unverifiable, never a fleet of foreign_pixel alerts', () => {
    // With nothing to compare against, "this pixel is not yours" is a claim we cannot make.
    const v = evaluateLandingPageCoverage(
      [site], { 'https://s.test/': { status: 'measured', detectedPixelIds: ['111'] } }, [],
    );
    expect(v.alerting).toHaveLength(0);
    expect(v.unverifiable).toHaveLength(1);
  });

  it('an unreadable page is unverifiable, never a finding', () => {
    for (const obs of [
      { 'https://s.test/': { status: 'unverifiable', detectedPixelIds: [] } },
      {},
    ]) {
      const v = evaluateLandingPageCoverage([site], obs as any, ['999']);
      expect(v.alerting).toHaveLength(0);
      expect(v.unverifiable).toHaveLength(1);
    }
  });

  it('carries sitesNotChecked through so truncation stays visible', () => {
    const v = evaluateLandingPageCoverage([], {}, ['999'], 4);
    expect(v.sitesNotChecked).toBe(4);
  });

  it('tolerates null input everywhere', () => {
    const v = evaluateLandingPageCoverage(null, null, null);
    expect(v).toMatchObject({ alerting: [], unverifiable: [], okCount: 0 });
  });
});


describe('weekly rotation — risk 1, fixed rather than documented', () => {
  it('checks each site on exactly one day of the rotation window', () => {
    const days = Array.from({ length: SITE_ROTATION_DAYS }, (_, d) =>
      shouldCheckSiteToday('site-abc', new Date(Date.UTC(2026, 7, 19) + d * 86_400_000)));
    expect(days.filter(Boolean)).toHaveLength(1);
  });

  it('is deterministic — the same site and date always agree', () => {
    const when = new Date(Date.UTC(2026, 7, 19));
    expect(shouldCheckSiteToday('site-abc', when)).toBe(shouldCheckSiteToday('site-abc', when));
  });

  it('spreads sites across the window instead of bursting on one day', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `site-${i}`);
    const when = new Date(Date.UTC(2026, 7, 19));
    const dueToday = ids.filter((id) => shouldCheckSiteToday(id, when)).length;
    // ~1/7th, not all of them. Generous bounds: this asserts spread, not a distribution.
    expect(dueToday).toBeGreaterThan(0);
    expect(dueToday).toBeLessThan(ids.length / 2);
  });

  it('reports what it DEFERRED, so "not due" never looks like "healthy"', () => {
    const when = new Date(Date.UTC(2026, 7, 19));
    const many = Array.from({ length: 30 }, (_, i) =>
      page({ id: `p${i}`, siteId: `site-${i}`, deployedUrl: `https://s${i}.test/` }));
    const { sites, sitesDeferred } = collectSitesToCheck(many, when);
    expect(sitesDeferred).toBeGreaterThan(0);
    expect(sites.length + sitesDeferred).toBeLessThanOrEqual(30);
  });

  it('returns nothing for an empty site id rather than treating it as due', () => {
    expect(shouldCheckSiteToday('')).toBe(false);
  });
});

describe('unconfirmed — risk 2, a client-side pixel must not page anyone', () => {
  const site = {
    siteId: 's1', pageId: 'p1', pageName: 'Lander',
    url: 'https://s.test/', recordedPixelId: '999',
  };

  it('downgrades to unconfirmed when the RECORD says we installed an owned pixel', () => {
    // We fetch without executing JS, so a client-side injection reads as bare. The record is
    // evidence we installed it deliberately and outranks one unexecuted read.
    const v = evaluateLandingPageCoverage(
      [site], { 'https://s.test/': { status: 'unmeasured', detectedPixelIds: [] } }, ['999'],
    );
    expect(v.alerting).toHaveLength(0);
    expect(v.unconfirmed).toHaveLength(1);
  });

  it('STILL alerts when the record claims a pixel the account does not own', () => {
    const v = evaluateLandingPageCoverage(
      [{ ...site, recordedPixelId: '111' }],
      { 'https://s.test/': { status: 'unmeasured', detectedPixelIds: [] } }, ['999'],
    );
    expect(v.alerting).toHaveLength(1);
    expect(v.unconfirmed).toHaveLength(0);
  });

  it('STILL alerts when the record claims nothing at all', () => {
    const v = evaluateLandingPageCoverage(
      [{ ...site, recordedPixelId: undefined }],
      { 'https://s.test/': { status: 'unmeasured', detectedPixelIds: [] } }, ['999'],
    );
    expect(v.alerting).toHaveLength(1);
  });
});
