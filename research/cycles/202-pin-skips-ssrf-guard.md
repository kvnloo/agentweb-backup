# Cycle 202 — Pin does not call `ssrfGuard`; cssExtractor’s local `validateURL` is thinner and company-URL-only

**Date:** 2026-09-12T04:00:00Z
**Question:** Cycle 201 next: pin has no `validateURL` /
SSRF check; cssExtractor only validates the company URL?

**Answer:** Yes. `downloadBrandLogoToS3` (`brandLogo.ts`
L374) axios.gets `logoUrl` with no import of
`utils/ssrfGuard.ts`. Probe L492 same. Leaf
`processInputImage` grep of `ssrfGuard` is empty.
cssExtractor’s **module-private** `validateURL`
(L142–167) runs only on the **company** URL
(`extractCSSFromURL` L913) and stylesheet hrefs
(L875). It is **not exported**. Discovered
`brandIdentity.logoUrl` (og:image / img src) is a
different host and is never passed through it.

The repo already has the in-process helper:
`assertPublicHostname` / `fetchBufferFollowingRedirects`
(`ssrfGuard.ts`). `describe_image` uses it for
non-own-bucket URLs (L9354–9363, ENG-834 hop-by-hop
pin). CRM `load-from-url` uses `assertPublicHostname`.
cssExtractor reinvented a **thinner** copy: localhost /
`127.0.0.1` / `0.0.0.0` and a 10/172.16–31/192.168
regex. Tests pin those company-URL throws
(`cssExtractor.test.ts` L298–307). The local copy does
not DNS-pin and does not share `FORBIDDEN_HOSTNAMES`
(`ssrfGuard.ts` L25–31). Axios default follows
redirects; `fetchBufferFollowingRedirects` re-pins
every hop (L246).

Emma `update_brand_guidelines` `logoUrl` is a free
string (`emma/tools.ts` L2063). Occupied `#2832` — do
not edit. Auto-pin then fetches it. Tests of the pin
use `https://acme.com/logo.png`; `__tests__` grep
`ssrfGuard` in `agentModeBrandLogo.test.ts` is empty.

Not a fifth HTTP service. The guard is already a
logical nanoservice. A-008 persist (after #2) should
call it from pin / probe / leaf. Do not add A-021.
Do not un-ready Q-014 (Emma already forwards
`inputImages`; listing does not add a new fetch).

## Evidence

cssExtractor — company URL only, not exported:

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

```908:913:backend/src/services/cssExtractor.ts
export async function extractCSSFromURL(
  urlString: string,
  options: ExtractionOptions = {}
): Promise<ExtractedCSS> {
  const url = validateURL(urlString);
```

Pin — neither helper:

```371:377:backend/src/services/agentMode/brandLogo.ts
    console.log(`Downloading logo from ${logoUrl}...`);
    const axios = (await import('axios')).default;
    logoResponse = await axios.get(logoUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
    });
```

The existing in-process guard, already on a sibling
image fetch:

```9354:9363:backend/src/services/agentModeService.ts
            // describe_image is an agent-callable foundation tool fed image URLs
            // from untrusted content, so this server-side fetch of an agent-supplied
            // URL is a reachable SSRF vector (cloud metadata, RFC1918/loopback).
            // fetchBufferFollowingRedirects validates that the host resolves to a
            // public IP and pins the connection to that exact address (DNS-rebinding
            // safe) on EVERY hop
            const fetched = await fetchBufferFollowingRedirects(fetchUrl);
```

Emma schema (occupied `#2832`):

```2063:2063:backend/src/emma/tools.ts
            logoUrl: { type: 'string', description: 'Direct URL to the brand logo as discovered on the company website (e.g. https://example.com/logo.svg). Used by the onboarding review screens and downstream creative/ad surfaces.' },
```

Hermes one fetch client. Copying `ssrfGuard` onto the
pin is the modular-monolith move. Do not HTTP-split.
Do not patch `brandLogo.ts` / `cssExtractor.ts` /
`emma/tools.ts` on a research turn. Do not write a
reproduction.

## Relation to A-002 / A-007 / A-008

A-008 persist owns one fetch: UA (cycle 201) +
own-bucket Path A (cycle 200) + `ssrfGuard` (this
cycle). Until then describe_image and logo pin
disagree on whether an agent-supplied URL is fetchable.
Do not revive A-006.

## Next cycle candidate

cssExtractor’s local `validateURL` vs `ssrfGuard`
`FORBIDDEN_HOSTNAMES` / DNS-pin on the **company**
scrape itself. Or pin/probe missing `Referer`. Or Emma
`read_brand_guidelines` L27884 `filename`. File-level.
Do not add A-021.
