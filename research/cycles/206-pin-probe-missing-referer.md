# Cycle 206 — Pin/probe omit `Referer`; Chrome scrape still sends it

**Date:** 2026-09-12T03:21:00Z
**Question:** Cycle 205 next: pin/probe missing
`Referer` (Chrome scrape sends it on
subresources)?

**Answer:** Cycle 204 already showed
`setExtraHTTPHeaders` is Cache-Control / Pragma
only (`cssExtractor.ts` L554–557; test L633–635).
That is the **extra** header map. Headless
Chrome/120 still emits a browser `Referer` on
`<img>` and `<link rel=icon>` while waiting
`networkidle2` (L559). The logo cascade then
retries those URLs over axios with **no**
`Referer`.

Pin (`brandLogo.ts` L374–377) has no `headers`
key. Tests **characterize** that
(`agentModeBrandLogo.test.ts` L243–246). Probe
L492–496 sends Mozilla UA only. Leaf
`processInputImage` (`imageGeneration.ts` L818–823)
is the same Mozilla-only map. Video
`processInputImage` (`videoGeneration.ts` L239–242)
sends no headers at all. `ssrfGuard`
`defaultPinnedRequest` L329–344 also has no
Referer.

Cycle 201 is the **UA** split (pin-fail +
probe-success). A Referer-gated CDN 403s **both**
pin and probe (both axios; neither sends Referer)
after scrape “found” the URL. Ads
`isBrandLogoFetchable` fail closed on 4xx (cycle
200). Logo stays unpinned. Occupied: `app.ts`
`#2271` (inbound `Referrer-Policy: no-referrer`
L192–193 is a leak-prevention header, not this
outbound fetch). OpenRouter L2370
`HTTP-Referer` is API attribution. Do not add
A-021. Do not write a hotlink PoC. Do not
un-ready Q-014.

## Evidence

Pin — no `headers` key. Tests pin object
equality:

```374:377:backend/src/services/agentMode/brandLogo.ts
    logoResponse = await axios.get(logoUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
    });
```

```243:246:backend/src/__tests__/agentModeBrandLogo.test.ts
    expect(mockedAxiosGet).toHaveBeenCalledWith('https://acme.com/logo.png', {
      responseType: 'arraybuffer',
      timeout: 15000,
    });
```

Probe — Mozilla UA, no Referer:

```492:496:backend/src/services/agentMode/brandLogo.ts
      return axios.get(url, {
        responseType: 'arraybuffer',
        timeout: LOGO_PROBE_TIMEOUT_MS,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AgentWeb/1.0)' },
      });
```

Preferred scrape — extra headers omit Referer;
Chrome still fetches subresources during
`networkidle2`:

```546:561:backend/src/services/cssExtractor.ts
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setCacheEnabled(false);
    await page.setExtraHTTPHeaders({
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    });
    await page.goto(url.toString(), {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
```

```632:635:backend/src/__tests__/cssExtractor.test.ts
      expect(mockPage.setExtraHTTPHeaders).toHaveBeenCalledWith(
        expect.objectContaining({ 'Cache-Control': 'no-cache', Pragma: 'no-cache' })
      );
```

Logo cascade — P1 apple-touch-icon (Chrome often
fetches), P2 `og:image` meta (typically **not**
fetched as an image), P3/P4 header/`logo` imgs
(Chrome fetches with `Referer` = company page):

```672:709:backend/src/services/cssExtractor.ts
      // Logo URL (priority cascade)
      let logoUrl: string | null = null;
      // P1: apple-touch-icon or PNG icon
      // ...
      // P2: og:image
      // P3: img in header/nav
      // P4: img with "logo" in alt/class
```

Leaf ads path — Mozilla only (cycle 201 UA
string; still no Referer):

```818:823:backend/src/services/imageGeneration.ts
    const imageResponse = await axios.get(imageUrl, { 
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AgentWeb/1.0)'
      }
    });
```

Video Path C — no headers (cycle 195):

```239:242:backend/src/services/videoGeneration.ts
      const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });
```

Inbound API policy is the opposite of sending
Referer outbound (occupied `#2271`):

```192:193:backend/src/app.ts
  // Do not leak the full URL (which may contain tokens/ids) in the Referer header.
  res.setHeader("Referrer-Policy", "no-referrer");
```

```72:74:backend/src/__tests__/securityHeaders.test.ts
  it('sets a Referrer-Policy header', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
```

OpenRouter `HTTP-Referer` is vendor attribution,
not a brand-logo fetch:

```2369:2371:backend/src/services/agentModeService.ts
          defaultHeaders: {
            'HTTP-Referer': 'https://app.agentweb.pro',
            'X-Title': 'AgentWeb',
```

`ssrfGuard` default transport also omits it:

```322:338:backend/src/utils/ssrfGuard.ts
async function defaultPinnedRequest(
  url: string,
  pinned: { address: string; family: number },
  timeoutMs: number,
  maxBytes: number
): Promise<HttpResponseLike> {
  const axios = (await import('axios')).default;
  return axios.get(url, {
    responseType: 'arraybuffer',
    timeout: timeoutMs,
    maxContentLength: maxBytes,
    maxBodyLength: maxBytes,
    maxRedirects: 0,
```

Grep of `backend/src/services/agentMode` for
`Referer` is empty. Do not patch. Do not write
a reproduction.

## Relation to A-002 / A-007 / A-008

A-008 persist (after #2) owns one fetch of bytes
it has: Path A/C **plus** one UA **plus** one
Referer policy **plus** `ssrfGuard`. Chrome
scrape discovering a URL is not a proof the
axios pin can GET it. Two in-process header
contracts is not A-006. Hermes: one client.

## Next cycle candidate

`generate_image.filename` is required on MCP
(`apiTools.ts` L2093) and Emma (`emma/tools.ts`
L5052). Cycle 205’s LLM-facing token is
`asset.filename` (`logo.png` / `'url'`). File-
level. Do not add A-021.
