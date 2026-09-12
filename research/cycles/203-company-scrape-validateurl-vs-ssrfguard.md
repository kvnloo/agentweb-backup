# Cycle 203 — Company-scrape `validateURL` misses `ssrfGuard` `FORBIDDEN_HOSTNAMES` / DNS-pin

**Date:** 2026-09-12T03:10:00Z
**Question:** Cycle 202 next: cssExtractor’s local
`validateURL` vs `ssrfGuard` `FORBIDDEN_HOSTNAMES` /
DNS-pin on the **company scrape itself**?

**Answer:** The scrape’s “SSRF” layer is a
hostname-string matcher. Tests characterize only
`localhost` / `10.` / `192.168` / `ftp`
(`cssExtractor.test.ts` L298–311). The in-process
guard `describe_image` already uses would additionally
reject cloud-metadata labels, link-local
`169.254.0.0/16`, the rest of `127.0.0.0/8`, CGNAT,
and IPv6 — and it DNS-pins. cssExtractor never looks
those up.

Preferred transport after that string check is
**Puppeteer** `page.goto` (`cssExtractor.ts` L559–562,
`networkidle2`, 30s). Chrome follows redirects and
loads subresources without re-running `validateURL`.
JSDOM fallback `fetchFreshHtmlFromValidatedUrl` L128
is a bare `axios.get` (no `maxRedirects: 0`).
Stylesheet hops L875 re-run the **same** string
matcher on the href, then axios follows redirects.
`ssrfGuard` L246–248 / L338 already documents why
that shape is the 302-to-metadata hole, and
`fetchBufferFollowingRedirects` re-pins every hop
(ENG-834).

Emma `read_page_source` `url` is a free string
(`emma/tools.ts` L6000). Occupied `#2832`. Onboarding
`brandLogo.ts` L589 also calls `extractCSSFromURL`.
Not a fifth HTTP service. A-008 persist (after #2)
should replace this local copy with `ssrfGuard`.
Do not add A-021. Do not un-ready Q-014.

## Evidence

Company scrape — string matcher, then Chrome:

```142:167:backend/src/services/cssExtractor.ts
function validateURL(urlString: string): URL {
  // ...
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '0.0.0.0') {
    throw new Error('Cannot fetch from localhost');
  }
  const privateIPRegex = /^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/;
  if (privateIPRegex.test(url.hostname)) {
    throw new Error('Cannot fetch from private IP ranges');
  }
  return url;
}
```

```559:562:backend/src/services/cssExtractor.ts
    await page.goto(url.toString(), {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
```

Tests pin RFC1918 literals + ftp, not metadata /
link-local / DNS:

```298:311:backend/src/__tests__/cssExtractor.test.ts
    it('should throw on SSRF localhost', async () => {
      await expect(extractCSSFromURL('http://localhost:3000')).rejects.toThrow('Cannot fetch from localhost');
    });
    it('should throw on SSRF private IP ranges', async () => {
      await expect(extractCSSFromURL('http://192.168.1.1')).rejects.toThrow('Cannot fetch from private IP ranges');
    });
    it('should throw on SSRF 10.x.x.x private IP', async () => {
      await expect(extractCSSFromURL('http://10.0.0.1')).rejects.toThrow('Cannot fetch from private IP ranges');
    });
    it('should throw on non-HTTP protocol', async () => {
      await expect(extractCSSFromURL('ftp://example.com')).rejects.toThrow('URL must be HTTP or HTTPS');
    });
```

`ssrfGuard` already characterizes the missing set
(no DNS mock needed for the labels; DNS mock for
`169.254`):

```25:31:backend/src/utils/ssrfGuard.ts
const FORBIDDEN_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.aws.internal',
  'metadata',
]);
```

```55:59:backend/src/__tests__/ssrfGuard.test.ts
  it('rejects 169.254.169.254 (link-local / cloud metadata)', async () => {
    mockResolvesTo('169.254.169.254');
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://meta.example.com')).rejects.toThrow(/private|internal/i);
  });
```

```96:103:backend/src/__tests__/ssrfGuard.test.ts
  it('rejects hostname `metadata.google.internal`', async () => {
    const { assertPublicHostname } = require('../utils/ssrfGuard');
    await expect(assertPublicHostname('http://metadata.google.internal/')).rejects.toThrow(/private|internal/i);
  });
```

Axios HTML fetch — default redirect follow, no pin:

```127:137:backend/src/services/cssExtractor.ts
export async function fetchFreshHtmlFromValidatedUrl(validatedUrl: string): Promise<string> {
  const response = await axios.get(validatedUrl, {
    timeout: 30000,
    headers: {
      'User-Agent': 'AgentWeb-CSS-Extractor/1.0',
```

Sibling in-process fetcher already has 169.254 **and**
DNS (`webContentFetcher.ts` L45–55 / L102–114) but
still `redirect: 'follow'` (L161) without hop re-pin.
Three policies, one process. Hermes: one fetch client.

Literal gaps vs `isPrivateIPv4` / `isPrivateIPv6`
(`ssrfGuard.ts` L48–113) that `validateURL` does not
inspect: `169.254.0.0/16`, `127.0.0.0/8` other than
`127.0.0.1`, `0.0.0.0/8` other than `0.0.0.0`,
`100.64.0.0/10`, `::1` / ULA `fc00::/7` / `fe80::/10`.
Do not write a reproduction.

Emma company URL (occupied `#2832`):

```6000:6003:backend/src/emma/tools.ts
        url: {
          type: 'string',
          description: 'The URL of the webpage to read and extract HTML source from'
        },
```

## Relation to A-002 / A-007 / A-008

A-008 persist owns one fetch: UA (cycle 201) +
own-bucket Path A (cycle 200) + `ssrfGuard` on pin
(cycle 202) **and** on the company scrape that
discovers the logo URL (this cycle). Puppeteer
`page.goto` is a second transport in the same file;
replacing `validateURL` does not pin Chrome’s
subresource loads — that stays a later in-process
slice, not A-006.

## Next cycle candidate

Pin/probe missing `Referer`. Or Puppeteer Mac Chrome
UA (`cssExtractor.ts` L546–548) vs axios
`AgentWeb-CSS-Extractor/1.0` (fourth UA on the
scrape). Or Emma `read_brand_guidelines` L27884
`filename`. File-level. Do not add A-021.
