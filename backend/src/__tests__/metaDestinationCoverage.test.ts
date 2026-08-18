/**
 * ENG-926 §G — is an ACTIVE ad sending paid traffic to a page that cannot measure it?
 *
 * Every case below was chosen from a read-only probe of the 21 real production ad accounts
 * on 2026-08-18, not invented. The probe found 6 accounts with ACTIVE ads, 46 destination
 * URLs collapsing to 6 distinct ones, and — importantly — that HALF the failure modes here
 * are NOT findings:
 *
 *   - 41 of 84 ACTIVE ads returned no destination URL at all (on-Facebook lead forms)
 *   - one destination was `www.facebook.com/profile.php?…` (a Page, not a website)
 *   - one real site answered 403 to a plain fetch (bot protection)
 *   - every pixel-less account ran ONLY LINK_CLICKS / MESSAGES / OUTCOME_ENGAGEMENT
 *
 * A check that alerted on any of those would page a human about correct configuration on
 * its first run. That is how §F's own history says a channel stops being read, so each one
 * is pinned here as explicitly NOT alerting.
 */

import {
  evaluateDestinationCoverage,
  collectCheckableUrls,
  isCheckableDestination,
  MAX_DESTINATION_URLS_CHECKED,
  type DestinationAd,
  type DestinationObservation,
} from '../services/metaDestinationCoverage';

const OWNED = ['910841031004192', '4411503379135789'];

const ad = (over: Partial<DestinationAd> = {}): DestinationAd => ({
  adId: 'ad_1',
  adName: 'Ad One',
  campaignId: 'c_1',
  campaignName: 'Lead Gen',
  objective: 'OUTCOME_LEADS',
  destinationUrls: ['https://example.com/lp'],
  ...over,
});

const obs = (
  url: string,
  status: DestinationObservation['status'],
  detectedPixelIds: string[] = [],
  error?: string,
): Record<string, DestinationObservation> => ({ [url]: { url, status, detectedPixelIds, error } });

describe('isCheckableDestination — what is even a website', () => {
  it('accepts ordinary http(s) pages', () => {
    expect(isCheckableDestination('https://example.com/lp')).toBe(true);
    expect(isCheckableDestination('http://example.com/lp')).toBe(true);
  });

  it('rejects Meta-owned SUBDOMAINS, not just the bare domain', () => {
    // Exact-match-after-stripping-www let all of these through to the fetcher, where a 200
    // with no owned pixel would produce a finding against a host that can never carry a page
    // pixel. `l.facebook.com` is Meta's own link shim and a plausible real destination.
    for (const host of [
      'l.facebook.com', 'web.facebook.com', 'm.facebook.com', 'business.facebook.com',
      'l.instagram.com', 'api.whatsapp.com',
    ]) {
      expect(isCheckableDestination(`https://${host}/x`)).toBe(false);
    }
    // A fully-qualified name is the same host.
    expect(isCheckableDestination('https://facebook.com./x')).toBe(false);
  });

  it('does NOT reject a lookalike domain that merely ends in the same letters', () => {
    // Suffix matching must anchor on a dot, or `notfacebook.com` becomes unreachable.
    expect(isCheckableDestination('https://notfacebook.com/lp')).toBe(true);
    expect(isCheckableDestination('https://my-instagram.com/lp')).toBe(true);
  });

  it('rejects app-store subdomains by the same rule', () => {
    expect(isCheckableDestination('https://apps.apple.com/us/app/x')).toBe(false);
  });

  it('rejects Meta-owned destinations — an ad pointing at a Page has no lander to measure', () => {
    // Seen live: one ACTIVE ad's destination was www.facebook.com/profile.php?id=…
    expect(isCheckableDestination('https://www.facebook.com/profile.php?id=1145')).toBe(false);
    expect(isCheckableDestination('https://instagram.com/someprofile')).toBe(false);
    expect(isCheckableDestination('https://m.me/somepage')).toBe(false);
    expect(isCheckableDestination('https://wa.me/15550100839')).toBe(false);
  });

  it('rejects non-http schemes rather than handing them to a fetcher', () => {
    expect(isCheckableDestination('tel:+15550100839')).toBe(false);
    expect(isCheckableDestination('mailto:sales@example.com')).toBe(false);
    expect(isCheckableDestination('fb://page/1145')).toBe(false);
  });

  it('rejects malformed input without throwing', () => {
    expect(isCheckableDestination('')).toBe(false);
    expect(isCheckableDestination('not a url')).toBe(false);
    expect(isCheckableDestination(undefined as any)).toBe(false);
    expect(isCheckableDestination(null as any)).toBe(false);
  });
});

describe('collectCheckableUrls — dedupe and cap', () => {
  it('collapses duplicates, because 46 real ad destinations were only 6 distinct pages', () => {
    const ads = [
      ad({ adId: 'a', destinationUrls: ['https://x.com/lp'] }),
      ad({ adId: 'b', destinationUrls: ['https://x.com/lp'] }),
      ad({ adId: 'c', destinationUrls: ['https://x.com/other'] }),
    ];
    expect(collectCheckableUrls(ads).urls).toEqual(['https://x.com/lp', 'https://x.com/other']);
  });

  it('drops non-website destinations before anything tries to fetch them', () => {
    const ads = [ad({ destinationUrls: ['https://www.facebook.com/p', 'https://x.com/lp'] })];
    expect(collectCheckableUrls(ads).urls).toEqual(['https://x.com/lp']);
  });

  it('does not spend a cap slot on an ad whose objective was never read', () => {
    // evaluateDestinationCoverage can only ever mark these `unverifiable`, so fetching them
    // wastes work AND can push a judgeable destination past the cap into urlsNotChecked.
    const ads = [
      ad({ adId: 'unknown', objective: undefined, destinationUrls: ['https://x.com/unknown'] }),
      ad({ adId: 'blank', objective: '   ', destinationUrls: ['https://x.com/blank'] }),
      ad({ adId: 'good', destinationUrls: ['https://x.com/good'] }),
    ];
    expect(collectCheckableUrls(ads).urls).toEqual(['https://x.com/good']);
  });

  it('ignores ads under a non-conversion objective — every pixel-less real account was one', () => {
    const ads = [
      ad({ adId: 'eng', objective: 'OUTCOME_ENGAGEMENT', destinationUrls: ['https://x.com/eng'] }),
      ad({ adId: 'clicks', objective: 'LINK_CLICKS', destinationUrls: ['https://x.com/clicks'] }),
      ad({ adId: 'msg', objective: 'MESSAGES', destinationUrls: ['https://x.com/msg'] }),
    ];
    expect(collectCheckableUrls(ads).urls).toEqual([]);
  });

  it('skips null and non-object entries rather than throwing mid-sweep', () => {
    const ads = [null as any, 'nope' as any, ad({ destinationUrls: ['https://x.com/lp'] })];
    expect(collectCheckableUrls(ads).urls).toEqual(['https://x.com/lp']);
  });

  it('tolerates destinationUrls that is not an array', () => {
    expect(collectCheckableUrls([ad({ destinationUrls: 'https://x.com/lp' as any })]).urls).toEqual([]);
  });

  it('SURFACES what the cap dropped, so a reduced check cannot pass for a complete one', () => {
    const ads = Array.from({ length: MAX_DESTINATION_URLS_CHECKED + 3 }, (_, i) =>
      ad({ adId: `ad_${i}`, destinationUrls: [`https://x.com/lp${i}`] }));
    const { urls, urlsNotChecked } = collectCheckableUrls(ads);
    expect(urls).toHaveLength(MAX_DESTINATION_URLS_CHECKED);
    expect(urlsNotChecked).toHaveLength(3);
  });
});

describe('evaluateDestinationCoverage — the cases that must NEVER alert', () => {
  it('an ad with no destination URL is a lead form, not a fault (41 of 84 real ACTIVE ads)', () => {
    const v = evaluateDestinationCoverage([ad({ destinationUrls: [] })], {}, OWNED);
    expect(v.alerting).toEqual([]);
    expect(v.notApplicable).toEqual([
      expect.objectContaining({ adId: 'ad_1', reason: 'no_destination' }),
    ]);
  });

  it('a non-conversion objective is never judged — an engagement ad needs no pixel', () => {
    const a = ad({ objective: 'OUTCOME_ENGAGEMENT' });
    const v = evaluateDestinationCoverage([a], obs('https://example.com/lp', 'unmeasured'), OWNED);
    expect(v.alerting).toEqual([]);
    expect(v.notApplicable).toEqual([
      expect.objectContaining({ reason: 'non_conversion_objective' }),
    ]);
  });

  it('a 403 is bot protection, not a missing pixel — one of four real sites answered 403', () => {
    const v = evaluateDestinationCoverage(
      [ad()], obs('https://example.com/lp', 'unverifiable', [], 'HTTP 403'), OWNED);
    expect(v.alerting).toEqual([]);
    expect(v.unverifiable).toEqual([
      expect.objectContaining({ url: 'https://example.com/lp', error: 'HTTP 403' }),
    ]);
  });

  it('a URL that was never observed is unverifiable, NOT healthy', () => {
    // The dangerous direction: an unobserved URL defaulting to "fine" would make a sweep
    // that fetched nothing at all report a clean bill of health for every account.
    const v = evaluateDestinationCoverage([ad()], {}, OWNED);
    expect(v.alerting).toEqual([]);
    expect(v.okCount).toBe(0);
    expect(v.unverifiable).toHaveLength(1);
  });

  it('a Meta-owned destination is not applicable rather than unmeasured', () => {
    const a = ad({ destinationUrls: ['https://www.facebook.com/profile.php?id=1145'] });
    const v = evaluateDestinationCoverage([a], {}, OWNED);
    expect(v.alerting).toEqual([]);
    expect(v.notApplicable).toEqual([expect.objectContaining({ reason: 'not_a_website' })]);
  });
});

describe('evaluateDestinationCoverage — the cases that MUST alert', () => {
  it('a 200 page carrying no pixel at all is a deterministic finding', () => {
    // RankAI's incident exactly: ~$5.2k spent against a lander that could not report.
    const v = evaluateDestinationCoverage(
      [ad()], obs('https://example.com/lp', 'unmeasured'), OWNED);
    expect(v.alerting).toEqual([
      expect.objectContaining({ adId: 'ad_1', url: 'https://example.com/lp', reason: 'no_pixel' }),
    ]);
  });

  it('a page carrying a pixel the ACCOUNT DOES NOT OWN is the hireemma.ai failure', () => {
    // The page looks instrumented and the spend still reports nothing back to this account.
    // A naive "is there any tracking?" check passes this, which is why ownership is the test.
    const v = evaluateDestinationCoverage(
      [ad()], obs('https://example.com/lp', 'measured', ['999999999999999']), OWNED);
    expect(v.alerting).toEqual([
      expect.objectContaining({ reason: 'foreign_pixel', detectedPixelIds: ['999999999999999'] }),
    ]);
  });

  it('an UNKNOWN objective is judged, not skipped — silence is the failure this card exists to end', () => {
    const a = ad({ objective: 'OUTCOME_SOMETHING_NEW' });
    const v = evaluateDestinationCoverage([a], obs('https://example.com/lp', 'unmeasured'), OWNED);
    expect(v.alerting).toHaveLength(1);
  });

  it('a carousel is only measured if EVERY card is — one bad card is a hole in the attribution', () => {
    const a = ad({ destinationUrls: ['https://example.com/good', 'https://example.com/bad'] });
    const observations = {
      ...obs('https://example.com/good', 'measured', [OWNED[0]]),
      ...obs('https://example.com/bad', 'unmeasured'),
    };
    const v = evaluateDestinationCoverage([a], observations, OWNED);
    expect(v.alerting).toEqual([
      expect.objectContaining({ url: 'https://example.com/bad', reason: 'no_pixel' }),
    ]);
  });
});

describe('evaluateDestinationCoverage — the healthy path', () => {
  it('a page carrying a pixel the account owns is clean', () => {
    // Live shape: everyio.agentwebforms.com serves 1311221084072225, which its own ad
    // account owns; phoenixtechnologies.io serves 910841031004192, likewise.
    const v = evaluateDestinationCoverage(
      [ad()], obs('https://example.com/lp', 'measured', [OWNED[0]]), OWNED);
    expect(v.alerting).toEqual([]);
    expect(v.unverifiable).toEqual([]);
    expect(v.okCount).toBe(1);
  });

  it('one of several detected pixels being owned is enough', () => {
    // Real accounts carry several pixels (Phoenix has three). A page may load more than one.
    const v = evaluateDestinationCoverage(
      [ad()], obs('https://example.com/lp', 'measured', ['999999999999999', OWNED[1]]), OWNED);
    expect(v.alerting).toEqual([]);
    expect(v.okCount).toBe(1);
  });

  it('reports one finding per ad+URL, so two ads on one bad page are two rows, not one', () => {
    const ads = [
      ad({ adId: 'a', destinationUrls: ['https://example.com/lp'] }),
      ad({ adId: 'b', destinationUrls: ['https://example.com/lp'] }),
    ];
    const v = evaluateDestinationCoverage(ads, obs('https://example.com/lp', 'unmeasured'), OWNED);
    expect(v.alerting.map((f) => f.adId)).toEqual(['a', 'b']);
  });
});

describe('malformed input', () => {
  it('never throws on absent or wrong-shaped input', () => {
    expect(() => evaluateDestinationCoverage([], {}, [])).not.toThrow();
    expect(() => evaluateDestinationCoverage(undefined as any, undefined as any, undefined as any)).not.toThrow();
    expect(() => collectCheckableUrls(undefined as any)).not.toThrow();
  });

  it('skips null and non-object entries in the ads array', () => {
    const v = evaluateDestinationCoverage(
      [null as any, 'nope' as any, ad()], obs('https://example.com/lp', 'measured', [OWNED[0]]), OWNED);
    expect(v.okCount).toBe(1);
  });

  it('skips an ad whose id is not a string, rather than emitting a finding with no subject', () => {
    // A finding nobody can trace back to an ad is worse than no finding: it names a problem
    // and gives no way to act on it.
    const v = evaluateDestinationCoverage(
      [ad({ adId: 42 as any })], obs('https://example.com/lp', 'unmeasured'), OWNED);
    expect(v.alerting).toEqual([]);
  });

  it('tolerates destinationUrls that is not an array', () => {
    const v = evaluateDestinationCoverage([ad({ destinationUrls: 'https://x' as any })], {}, OWNED);
    expect(v.notApplicable).toEqual([expect.objectContaining({ reason: 'no_destination' })]);
  });

  it('tolerates blank and non-string destination entries', () => {
    const v = evaluateDestinationCoverage(
      [ad({ destinationUrls: ['   ', null as any, 7 as any] })], {}, OWNED);
    expect(v.notApplicable).toEqual([expect.objectContaining({ reason: 'no_destination' })]);
  });

  it('tolerates an observations bag that is not an object', () => {
    const v = evaluateDestinationCoverage([ad()], null as any, OWNED);
    expect(v.unverifiable).toHaveLength(1);
    expect(v.alerting).toEqual([]);
  });

  it('tolerates detectedPixelIds that is not an array', () => {
    const v = evaluateDestinationCoverage(
      [ad()],
      { 'https://example.com/lp': { url: 'https://example.com/lp', status: 'measured', detectedPixelIds: 'x' as any } },
      OWNED);
    expect(v.alerting).toEqual([expect.objectContaining({ reason: 'no_pixel' })]);
  });

  it('ignores blank entries in the owned-pixel list', () => {
    const v = evaluateDestinationCoverage(
      [ad()], obs('https://example.com/lp', 'measured', [OWNED[0]]), ['', null as any, OWNED[0]]);
    expect(v.okCount).toBe(1);
  });

  it('an account with NO owned pixels cannot produce a foreign-pixel alert it could never fix', () => {
    // A page carrying tracking while the account owns nothing is a connection problem, not a
    // page problem. Reported as unverifiable so it is visible without paging the wrong team.
    const v = evaluateDestinationCoverage(
      [ad()], obs('https://example.com/lp', 'measured', ['999999999999999']), []);
    expect(v.alerting).toEqual([]);
    expect(v.unverifiable).toHaveLength(1);
  });
});
