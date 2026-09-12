# Cycle 201 — Pin GET has no User-Agent; probe and discovery do

**Date:** 2026-09-12T03:40:00Z
**Question:** Cycle 200 next: `downloadBrandLogoToS3` GET
L374 has **no** User-Agent (15s); the ENG-792 probe has
one. External hotlink vs own-S3 probe?

**Answer:** Same file, two axios GETs, two header
contracts. Pin (`brandLogo.ts` L374–377) sends
`responseType` + `timeout: 15000` only. Tests
**characterize** that (`agentModeBrandLogo.test.ts`
L243–246). Probe L495 sends
`Mozilla/5.0 (compatible; AgentWeb/1.0)` — the same
string as leaf `processInputImage` (`imageGeneration.ts`
L822). Discovery (`cssExtractor.ts` L131 / L879) uses
a **third** string: `AgentWeb-CSS-Extractor/1.0`.
`brandLogo.ts` grep of `validateURL` is empty — the
pin fetches whatever URL Emma or the scraper handed it.

A site that requires a UA (or blocks axios’s default
`axios/<ver>`) can therefore: HTML-discover the logo
(Extractor UA) → pin **download-failed** (no UA) →
store the raw incoming URL (`updateBrandGuidelines`
keeps `brandData.logoUrl` on download-failed) → ads
`isBrandLogoFetchable` WITH Mozilla UA returns
`'usable'` → `logoImage` Path-C GET also has Mozilla
(cycle 194). ENG-326 “pinned to our S3” never happens;
the external host remains the source of truth. Cycle
200’s own-bucket Path C is the **success** path; this
is the **failure** path of the same two functions.
Occupied: `agentModeService.ts` callers. Not a
nanoservice. Do not add A-021. Do not un-ready Q-014.

## Evidence

Pin — no `headers` key. Tests pin the object equality:

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

Probe — Mozilla UA, same 15s:

```492:496:backend/src/services/agentMode/brandLogo.ts
      return axios.get(url, {
        responseType: 'arraybuffer',
        timeout: LOGO_PROBE_TIMEOUT_MS,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AgentWeb/1.0)' },
      });
```

Discovery — third UA, plus no-cache (HTML only; it
never fetches the image bytes):

```128:137:backend/src/services/cssExtractor.ts
  const response = await axios.get(validatedUrl, {
    timeout: 30000,
    headers: {
      'User-Agent': 'AgentWeb-CSS-Extractor/1.0',
      // Brand-build must scrape the CURRENT site — never a stale/CDN copy.
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
    responseType: 'text',
  });
```

Leaf ads path uses the probe’s Mozilla string:

```818:823:backend/src/services/imageGeneration.ts
    const imageResponse = await axios.get(imageUrl, { 
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AgentWeb/1.0)'
      }
    });
```

Video `processInputImage` L239–242 also has **no** UA
(cycle 195). Azure edit L654 has none (cycle 171).
`read_file_content` L28670 uses a **fourth** string:
`AgentWeb-Backend/1.0`. `__tests__` grep of
`AgentWeb-CSS-Extractor` / `compatible; AgentWeb/1.0`
is empty — only the pin’s missing-headers object is
asserted.

Neither pin nor probe sets `Referer` (hotlink-by-Referer
fails both). `cssExtractor.validateURL` SSRF-blocks
localhost on the **company** URL; `downloadBrandLogoToS3`
does not call it. Next cycle, not this one.

Hermes `_prepare_fal_request` fetches with one client.
A-008 persist (after #2) should one-header the pin,
probe, and leaf GET of a logo URL. Do not HTTP-split.
Do not patch `brandLogo.ts` on a research turn.

## Relation to A-002 / A-007 / A-008

A-008 persist owns one fetch helper (UA + timeout +
own-bucket Path A). Until then pin/probe/leaf can
disagree on whether the same URL “exists.” Do not
revive A-006.

## Next cycle candidate

Pin has no `validateURL` / SSRF check; cssExtractor
only validates the company URL. Emma
`update_brand_guidelines` can pass any `logoUrl`.
Or missing `Referer` on the pin. Or Emma
`read_brand_guidelines` L27884 `filename`. File-level.
Do not add A-021.
