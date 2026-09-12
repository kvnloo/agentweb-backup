# Cycle 204 — Company scrape’s preferred path spoofs Mac Chrome/120; axios fallback uses Extractor/1.0

**Date:** 2026-09-12T03:20:00Z
**Question:** Cycle 203 next: Puppeteer Mac Chrome UA
(`cssExtractor.ts` L546–548) vs axios
`AgentWeb-CSS-Extractor/1.0`? Or pin/probe missing
`Referer`?

**Answer:** Same `extractCSSFromURL`, two transports,
two User-Agents. Preferred path is Puppeteer
`page.setUserAgent` of a **Mac Chrome/120** desktop
string (L546–548), then `page.goto` (cycle 203).
JSDOM fallback HTML fetch (L131) and stylesheet GETs
(L879) send `AgentWeb-CSS-Extractor/1.0`. Cycle 201
named Extractor as “cssExtractor’s UA”; that is the
**fallback** face. Tests pin the no-cache headers
(`cssExtractor.test.ts` L620–635) and never the
Chrome/120 string (`setUserAgent` is mocked, never
`toHaveBeenCalledWith`).

A site that allows Chrome and blocks bot UAs (or the
reverse) can therefore: Puppeteer scrape succeeds →
logo URL discovered → pin with **no** UA (cycle 201)
fails → ads probe with Mozilla `AgentWeb/1.0` succeeds.
Or: Puppeteer fails (ENG-1162) → axios Extractor
retries the **same** company URL. LinkedIn’s sibling
Puppeteer already spoofs **Chrome/131**
(`linkedInService.ts` L608) — same Mac template, a
different version. Hermes: one fetch client.

`setExtraHTTPHeaders` is Cache-Control / Pragma only
(L554–557). No `Referer` on scrape, pin, or probe.
OpenRouter’s `HTTP-Referer` (`agentModeService.ts`
L2370) is API attribution, not this fetch. Occupied:
do not patch `cssExtractor.ts` on a research turn.
Do not add A-021. Do not un-ready Q-014.

## Evidence

Preferred scrape — desktop Chrome/120, no Referer:

```546:557:backend/src/services/cssExtractor.ts
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setCacheEnabled(false);
    await page.setExtraHTTPHeaders({
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    });
```

Axios fallback — third string (cycle 201 named this
as cssExtractor; it is the JSDOM face):

```128:131:backend/src/services/cssExtractor.ts
  const response = await axios.get(validatedUrl, {
    timeout: 30000,
    headers: {
      'User-Agent': 'AgentWeb-CSS-Extractor/1.0',
```

```877:880:backend/src/services/cssExtractor.ts
        const response = await axios.get(stylesheetURL.toString(), {
          timeout: 10000,
          headers: { 'User-Agent': 'AgentWeb-CSS-Extractor/1.0' },
```

Tests pin cache headers, not the UA:

```620:635:backend/src/__tests__/cssExtractor.test.ts
    it('disables the browser cache and sends no-cache headers so it scrapes the CURRENT site (no stale copy)', async () => {
      // ...
      expect(mockPage.setCacheEnabled).toHaveBeenCalledWith(false);
      expect(mockPage.setExtraHTTPHeaders).toHaveBeenCalledWith(
        expect.objectContaining({ 'Cache-Control': 'no-cache', Pragma: 'no-cache' })
      );
    });
```

Sibling Puppeteer — Chrome/131:

```608:609:backend/src/services/linkedInService.ts
          await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
```

Brand-build UA catalog after this cycle:

| Face | UA |
|---|---|
| Puppeteer company scrape | Mac Chrome/120 |
| Axios HTML / stylesheets | `AgentWeb-CSS-Extractor/1.0` |
| Logo pin | none (cycle 201) |
| Probe / leaf `processInputImage` | `Mozilla/5.0 (compatible; AgentWeb/1.0)` |
| LinkedIn OG scrape | Mac Chrome/131 |

## Relation to A-002 / A-007 / A-008

A-008 persist (after #2) owns one fetch client: one
UA + `ssrfGuard` (cycles 202–203) + own-bucket Path A
(cycle 200). Puppeteer vs axios is two transports in
one file, not a fifth process. Do not revive A-006.

## Next cycle candidate

Pin/probe missing `Referer` (scrape headers are
cache-only). Or Emma `read_brand_guidelines` L27884
`filename`. File-level. Do not add A-021.
