import {
  detectTrackingSnippets,
  checkUrlTracking,
  preflightTrackingGate,
  fetchHtmlFollowingRedirects,
  TRACKING_MECHANISMS,
} from '../services/googleAdsTrackingPreflight';

describe('googleAdsTrackingPreflight — detectTrackingSnippets', () => {
  it('detects a GA4 gtag measurement ID', () => {
    const html = `<script src="https://www.googletagmanager.com/gtag/js?id=G-ABC123XYZ"></script>`;
    expect(detectTrackingSnippets(html)).toContain('GA4:G-ABC123XYZ');
  });

  it('detects a GTM container ID', () => {
    const html = `<script>(function(w,d,s,l,i){})(window,document,'script','dataLayer','GTM-ABCD12');</script>`;
    expect(detectTrackingSnippets(html)).toContain('GTM:GTM-ABCD12');
  });

  it('detects a Google Ads conversion (AW-) snippet', () => {
    const html = `gtag('config', 'AW-123456789');`;
    expect(detectTrackingSnippets(html)).toContain('AW:AW-123456789');
  });

  it('returns an empty array when no tracking is present', () => {
    expect(detectTrackingSnippets('<html><body>No tracking here</body></html>')).toEqual([]);
  });

  it('returns an empty array for empty/invalid input', () => {
    expect(detectTrackingSnippets('')).toEqual([]);
    expect(detectTrackingSnippets(undefined as any)).toEqual([]);
  });

  it('de-duplicates repeated IDs', () => {
    const html = `G-ABC123XYZ ... G-ABC123XYZ`;
    expect(detectTrackingSnippets(html)).toEqual(['GA4:G-ABC123XYZ']);
  });
});

describe('googleAdsTrackingPreflight — checkUrlTracking', () => {
  it('marks a URL measured when tracking is found', async () => {
    const fetchHtml = jest.fn().mockResolvedValue('<script id="G-TEST123456"></script>');
    const result = await checkUrlTracking('https://example.com/lp', { fetchHtml });
    expect(result.status).toBe('measured');
    expect(result.mechanisms).toContain('GA4:G-TEST123456');
    expect(result.checkedFor).toEqual(TRACKING_MECHANISMS);
    expect(fetchHtml).toHaveBeenCalledWith('https://example.com/lp');
  });

  it('marks a URL unmeasured when no tracking is found', async () => {
    const fetchHtml = jest.fn().mockResolvedValue('<html>nothing</html>');
    const result = await checkUrlTracking('https://example.com/compare', { fetchHtml });
    expect(result.status).toBe('unmeasured');
    expect(result.mechanisms).toEqual([]);
  });

  it('marks a URL unverifiable (NOT measured) when the fetch fails', async () => {
    const fetchHtml = jest.fn().mockRejectedValue(new Error('timeout of 10000ms exceeded'));
    const result = await checkUrlTracking('https://example.com/down', { fetchHtml });
    expect(result.status).toBe('unverifiable');
    expect(result.error).toMatch(/timeout/);
  });

  it('marks a URL unverifiable on a 4xx/5xx (non-2xx surfaced as a thrown error)', async () => {
    const fetchHtml = jest.fn().mockRejectedValue(new Error('Request failed with status code 503'));
    const result = await checkUrlTracking('https://example.com/503', { fetchHtml });
    expect(result.status).toBe('unverifiable');
    expect(result.error).toMatch(/503/);
  });
});

describe('googleAdsTrackingPreflight — fetchHtmlFollowingRedirects', () => {
  const ok = (data: string) => ({ status: 200, headers: {}, data });
  const redirect = (location: string, status = 308) => ({ status, headers: { location }, data: '' });

  it('returns the body directly when there is no redirect', async () => {
    const get = jest.fn().mockResolvedValue(ok('<html>measured G-AAAA111111</html>'));
    const assertPublic = jest.fn().mockResolvedValue(undefined);
    const html = await fetchHtmlFollowingRedirects('https://a.com', { get, assertPublic });
    expect(html).toContain('G-AAAA111111');
    expect(assertPublic).toHaveBeenCalledTimes(1);
  });

  it('follows a 308 to another public host and returns the final 200 body', async () => {
    const get = jest.fn()
      .mockResolvedValueOnce(redirect('https://www.hireemma.ai/'))
      .mockResolvedValueOnce(ok('<script src="/gtag/js?id=G-KKJE0Q33LF"></script>'));
    const assertPublic = jest.fn().mockResolvedValue(undefined);
    const html = await fetchHtmlFollowingRedirects('https://agentweb.pro', { get, assertPublic });
    expect(html).toContain('G-KKJE0Q33LF');
    // SSRF guard re-run on BOTH the start URL and the redirect target.
    expect(assertPublic).toHaveBeenNthCalledWith(1, 'https://agentweb.pro');
    expect(assertPublic).toHaveBeenNthCalledWith(2, 'https://www.hireemma.ai/');
  });

  it('resolves a relative Location against the current URL', async () => {
    const get = jest.fn()
      .mockResolvedValueOnce(redirect('/final', 301))
      .mockResolvedValueOnce(ok('done'));
    const assertPublic = jest.fn().mockResolvedValue(undefined);
    await fetchHtmlFollowingRedirects('https://a.com/start', { get, assertPublic });
    expect(get).toHaveBeenNthCalledWith(2, 'https://a.com/final');
  });

  it('re-runs the SSRF guard on the redirect target (blocks redirect-to-internal)', async () => {
    const get = jest.fn().mockResolvedValue(redirect('http://169.254.169.254/latest/meta-data/'));
    const assertPublic = jest.fn()
      .mockResolvedValueOnce(undefined) // start URL is public
      .mockRejectedValueOnce(new Error('URL resolves to a private/internal address'));
    await expect(fetchHtmlFollowingRedirects('https://a.com', { get, assertPublic }))
      .rejects.toThrow(/private\/internal/);
  });

  it('throws (not measured) when redirects exceed the cap', async () => {
    const get = jest.fn().mockResolvedValue(redirect('https://a.com/loop'));
    const assertPublic = jest.fn().mockResolvedValue(undefined);
    await expect(fetchHtmlFollowingRedirects('https://a.com', { get, assertPublic, maxRedirects: 2 }))
      .rejects.toThrow(/too many redirects/i);
  });

  it('throws on a 3xx with no Location header', async () => {
    const get = jest.fn().mockResolvedValue({ status: 302, headers: {}, data: '' });
    const assertPublic = jest.fn().mockResolvedValue(undefined);
    await expect(fetchHtmlFollowingRedirects('https://a.com', { get, assertPublic }))
      .rejects.toThrow(/no Location header/);
  });

  it('refuses to follow a non-http(s) redirect', async () => {
    const get = jest.fn().mockResolvedValue(redirect('file:///etc/passwd'));
    const assertPublic = jest.fn().mockResolvedValue(undefined);
    await expect(fetchHtmlFollowingRedirects('https://a.com', { get, assertPublic }))
      .rejects.toThrow(/non-http/);
  });

  it('surfaces a 4xx/5xx as a thrown error (→ unverifiable)', async () => {
    const get = jest.fn().mockResolvedValue({ status: 404, headers: {}, data: '' });
    const assertPublic = jest.fn().mockResolvedValue(undefined);
    await expect(fetchHtmlFollowingRedirects('https://a.com', { get, assertPublic }))
      .rejects.toThrow(/status code 404/);
  });
});

describe('googleAdsTrackingPreflight — preflightTrackingGate', () => {
  const measured = '<script src="https://www.googletagmanager.com/gtag/js?id=G-AAAA111111"></script>';
  const unmeasured = '<html><body>no tags</body></html>';

  it('passes when every final URL is measured', async () => {
    const fetchHtml = jest.fn().mockResolvedValue(measured);
    const gate = await preflightTrackingGate(['https://a.com', 'https://b.com'], { fetchHtml });
    expect(gate.ok).toBe(true);
    expect(gate.blockedUrls).toEqual([]);
    expect(gate.message).toMatch(/passed/i);
  });

  it('blocks and names each unmeasured URL, with what was checked and how to fix', async () => {
    const fetchHtml = jest.fn().mockImplementation((url: string) =>
      Promise.resolve(url.includes('good') ? measured : unmeasured),
    );
    const gate = await preflightTrackingGate(
      ['https://good.com/lp', 'https://bad.com/compare'],
      { fetchHtml },
    );
    expect(gate.ok).toBe(false);
    expect(gate.blockedUrls.map((r) => r.url)).toEqual(['https://bad.com/compare']);
    expect(gate.message).toContain('https://bad.com/compare');
    expect(gate.message).not.toContain('https://good.com/lp');
    expect(gate.message).toMatch(/GA4/);
    expect(gate.message).toMatch(/override_tracking_check=true/);
  });

  it('blocks when a URL could not be verified (fetch failure ≠ pass)', async () => {
    const fetchHtml = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const gate = await preflightTrackingGate(['https://down.com'], { fetchHtml });
    expect(gate.ok).toBe(false);
    expect(gate.blockedUrls[0].status).toBe('unverifiable');
    expect(gate.message).toMatch(/could not verify/i);
  });

  it('de-duplicates URLs before checking', async () => {
    const fetchHtml = jest.fn().mockResolvedValue(measured);
    const gate = await preflightTrackingGate(
      ['https://a.com', 'https://a.com', ' https://a.com '],
      { fetchHtml },
    );
    expect(fetchHtml).toHaveBeenCalledTimes(1);
    expect(gate.results).toHaveLength(1);
  });

  it('treats an empty URL list as ok (nothing to gate)', async () => {
    const fetchHtml = jest.fn();
    const gate = await preflightTrackingGate([], { fetchHtml });
    expect(gate.ok).toBe(true);
    expect(fetchHtml).not.toHaveBeenCalled();
  });
});

describe('ENG-1358 — a GTM container is not proof an Ads conversion tag is in it', () => {
  // Found on a live campaign, not hypothesised. During the ENG-1182 run, Step 5 audited
  // the only ENABLED campaign's destination and found GTM-NFWK798Z with NO AW- id
  // anywhere in the served HTML. The gate passed it. The campaign's goal was
  // SUBMIT_LEAD_FORM, biddable — bidding toward an event that page could not report.
  //
  // A container is a PLACE where tags may live, not evidence any particular tag is in
  // it, and its contents are not readable over HTTP. So this is WARN, never BLOCK:
  // plenty of legitimate setups do fire the Ads conversion from inside GTM, and blocking
  // them would be the mirror-image error — training people to set override_tracking_check,
  // which is worse than the problem it solves.
  const page = (body: string) => `<html><head>${body}</head><body>hi</body></html>`;
  const withAw = page('<script src="https://www.googletagmanager.com/gtag/js?id=AW-18192751758"></script>');
  const withGtmOnly = page('<script>(function(){})(window,document,"script","dataLayer","GTM-NFWK798Z");</script>');
  const withGa4Only = page('<script src="https://www.googletagmanager.com/gtag/js?id=G-ABC1234"></script>');
  const withNothing = page('<title>nothing here</title>');
  const gate = (html: string) => preflightTrackingGate(['https://x.test/'], { fetchHtml: async () => html });

  it('AC1: a page carrying AW- still passes unchanged', async () => {
    const out = await gate(withAw);
    expect(out.ok).toBe(true);
    expect(out.blockedUrls).toEqual([]);
    expect(out.warnings ?? []).toEqual([]);
  });

  it('AC2: GTM-only does NOT block — a launch is still permitted', async () => {
    const out = await gate(withGtmOnly);
    expect(out.ok).toBe(true);
    expect(out.blockedUrls).toEqual([]);
  });

  it('AC2: GTM-only produces a warning rather than a clean pass', async () => {
    const out = await gate(withGtmOnly);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings![0].url).toBe('https://x.test/');
  });

  it('AC2: the warning names the specific unverifiable thing', async () => {
    // Not "tracking may be incomplete" — that is unactionable. It has to say that the
    // container may or may not contain an Ads conversion tag and that we cannot see in.
    const out = await gate(withGtmOnly);
    expect(out.message).toMatch(/GTM-NFWK798Z/);
    expect(out.message).toMatch(/cannot (see inside|be read)/i);
  });

  it('AC4: the warning states how to resolve it', async () => {
    // A warning with no route to resolution is one people learn to ignore.
    const out = await gate(withGtmOnly);
    expect(out.message).toMatch(/GTM Preview|beacon/i);
  });

  it('AC2: GA4-only warns for the same reason', async () => {
    const out = await gate(withGa4Only);
    expect(out.ok).toBe(true);
    expect(out.warnings).toHaveLength(1);
  });

  it('AC3: a page with none of the three still BLOCKS', async () => {
    const out = await gate(withNothing);
    expect(out.ok).toBe(false);
    expect(out.blockedUrls).toHaveLength(1);
  });

  it('a page with BOTH GTM and AW passes clean — the AW is what matters', async () => {
    const out = await gate(page(
      '<script>(function(){})(window,document,"script","dataLayer","GTM-NFWK798Z");</script>'
      + '<script src="https://www.googletagmanager.com/gtag/js?id=AW-18192751758"></script>',
    ));
    expect(out.ok).toBe(true);
    expect(out.warnings ?? []).toEqual([]);
  });

  it('an unverifiable fetch still blocks, and is not downgraded to a warning', async () => {
    // Blocked-by-default must survive this change: a page we could not read is not a
    // page we may assume is tagged.
    const out = await preflightTrackingGate(['https://x.test/'], {
      fetchHtml: async () => { throw new Error('timeout'); },
    });
    expect(out.ok).toBe(false);
    expect(out.warnings ?? []).toEqual([]);
  });

  it('warns per URL, so a mixed set names only the containers', async () => {
    const out = await preflightTrackingGate(
      ['https://tagged.test/', 'https://container.test/'],
      { fetchHtml: async (u) => (u.includes('tagged') ? withAw : withGtmOnly) },
    );
    expect(out.ok).toBe(true);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings![0].url).toBe('https://container.test/');
  });
});

describe('fetch-failure fallbacks (pre-existing branches, closed while here)', () => {
  it('falls back to a generic reason when the error carries no message', async () => {
    const out = await preflightTrackingGate(['https://x.test/'], {
      fetchHtml: async () => { throw {}; },
    });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/Could not fetch URL|unknown error/);
  });

  it('tolerates a null url list rather than throwing', async () => {
    const out = await preflightTrackingGate(null as any, {});
    expect(out.ok).toBe(true);
    expect(out.results).toEqual([]);
  });
});

describe('the warning must describe what was actually found (CodeRabbit, #2516)', () => {
  // Telling someone with a GA4-only page to "open GTM Preview on the container" sends
  // them looking for a container that does not exist. Advice that does not match what the
  // operator can see is how a warning gets written off as noise.
  const page = (b: string) => `<html><head>${b}</head><body>x</body></html>`;
  const gtmOnly = page('<script>(function(){})(window,document,"script","dataLayer","GTM-NFWK798Z");</script>');
  const ga4Only = page('<script src="https://www.googletagmanager.com/gtag/js?id=G-ABC1234"></script>');
  const gate = (html: string) => preflightTrackingGate(['https://x.test/'], { fetchHtml: async () => html });

  it('a GA4-only page is not described as having a GTM container', async () => {
    const out = await gate(ga4Only);
    expect(out.message).not.toMatch(/GTM container/);
    expect(out.message).not.toMatch(/GTM Preview/);
  });

  it('a GA4-only page is told the GA4-specific thing to check', async () => {
    const out = await gate(ga4Only);
    expect(out.message).toMatch(/GA4 property measures analytics/);
    expect(out.message).toMatch(/imported into Google Ads/);
  });

  it('a GTM page still gets the GTM advice', async () => {
    const out = await gate(gtmOnly);
    expect(out.message).toMatch(/GTM Preview/);
    expect(out.message).toMatch(/place where tags may live/);
  });

  it('both messages still name the beacon check, which works either way', async () => {
    for (const html of [gtmOnly, ga4Only]) {
      expect((await gate(html)).message).toMatch(/googleadservices\.com/);
    }
  });
});
