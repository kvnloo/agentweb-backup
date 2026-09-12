# Cycle 200 — ENG-792 probe is Path C of the Family A URL auto-pin just wrote

**Date:** 2026-09-12T03:25:00Z
**Question:** Cycle 199 next: `classifyBrandLogoUrl`
(`brandLogo.ts` L483) Path C of the persisted Family A
URL after auto-pin (ENG-792)?

**Answer:** Yes. Default fetcher is bare `axios.get`
(L492–496, 15s, with User-Agent). **No** `isS3Url` /
`presignS3Url` / `getS3ObjectStream` in `brandLogo.ts`.
After cycle 199 persist, `ensureBrandLogoPersisted`
L654 probes `existingAsset` — the Location
`downloadBrandLogoToS3` just returned. Same URL then
feeds `isBrandLogoFetchable` (`onboardingAdImageService.ts`
L723–727), a **fail-CLOSED** wrapper: only `'usable'`
lets ads run. A 4xx (including S3 403 on a private
object) is `'broken'` (L529), not `'unknown'`.

Opposite semantics, one probe:

| Caller | 4xx `'broken'` | `'unknown'` (timeout/5xx) |
|---|---|---|
| `ensureBrandLogoPersisted` | re-scrape (L654–661) | **keep** the logo |
| `isBrandLogoFetchable` (ads) | **block** the run | **block** the run |

`filesController.ts` L35 already SDK-streams own-bucket
URLs (“no public access needed”). This probe does not.
Tests inject `httpGet` against `https://s3/logo.png`
(L781) — not a Location spelling — and document that
S3 objects with no ContentType must stay `'usable'`
(L792–794). Default axios is untested. Occupied:
`agentModeService.ts` mint; probe is `brandLogo.ts`.
Not a nanoservice. Do not add A-021. Do not un-ready Q-014.

## Evidence

Default Path C (UA, unlike `downloadBrandLogoToS3` L374):

```488:496:backend/src/services/agentMode/brandLogo.ts
  const httpGet =
    deps.httpGet ??
    (async (url: string) => {
      const axios = (await import('axios')).default;
      return axios.get(url, {
        responseType: 'arraybuffer',
        timeout: LOGO_PROBE_TIMEOUT_MS,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AgentWeb/1.0)' },
      });
    });
```

4xx is definitive “not there”:

```524:530:backend/src/services/agentMode/brandLogo.ts
  } catch (err: any) {
    const status = err?.response?.status;
    // Real axios rejects on non-2xx and carries the response. A 4xx is a
    // definitive "not there"; everything else (timeout, DNS, 5xx, and any
    // error with no response attached) is inconclusive.
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return 'broken';
```

The comment on the probe names the leaf GET as the
reason it exists (`processInputImage` Path C, cycle 194)
and treats S3-without-ContentType as in-scope:

```473:481:backend/src/services/agentMode/brandLogo.ts
 * Probe a logo URL once and classify whether it currently serves usable
 * image bytes. Never throws.
 *
 * A 2xx with a generic or absent content-type counts as `'usable'`: the
 * downstream consumer (`imageGeneration.processInputImage` →
 * `getImageMimeType`) tolerates those by sniffing the URL extension and
 * defaulting to image/png, so rejecting them here would break logos that
 * work fine today (e.g. S3 objects with no ContentType metadata).
```

Ads fail closed on that same function:

```716:727:backend/src/services/onboardingAdImageService.ts
 * Thin fail-CLOSED wrapper over `classifyBrandLogoUrl` (the shared probe in
 * agentMode/brandLogo, which also backs the brand-build rediscovery gate).
 * Only an outright `'usable'` verdict lets the run proceed: an inconclusive
 * probe (timeout / DNS / 5xx) blocks too, because the alternative is burning
 * three Gemini calls to produce three placeholders.
export async function isBrandLogoFetchable(
  logoUrl: string,
  deps: BrandLogoProbeDeps = {}
): Promise<boolean> {
  return (await classifyBrandLogoUrl(logoUrl, deps)) === "usable";
}
```

Same repo already Path-A streams own bucket:

```35:36:backend/src/controllers/filesController.ts
    // If it's an S3 URL for our bucket, stream directly via SDK (no public access needed)
    const s3Key = extractS3KeyFromUrl(url, DEFAULT_BUCKET);
```

Cycle 199 skip-re-pin uses `isS3Url` (hits Family A) so
Emma does not re-download. The **probe** still HTTP-GETs
that Location. A private object after a successful pin
fails ads closed and makes onboarding rediscover. Hermes
keeps bytes it already uploaded. A-008 persist (after #2)
should own fetch-own-bucket (Path A) for this probe.
Do not HTTP-split. Do not patch `brandLogo.ts` on a
research turn.

## Relation to A-002 / A-007 / A-008

A-008 persist owns one writer, one stored key (cycle 199),
**and** one fetch of own-bucket URLs. Until then ENG-792
and `processInputImage` Path-C GET the Location helpers
return. Do not revive A-006.

## Next cycle candidate

`downloadBrandLogoToS3` GET L374 has **no** User-Agent
(15s); the probe has one. External hotlink vs own-S3
probe. Or Emma `read_brand_guidelines` L27884 showing
`filename`. File-level. Do not add A-021.
