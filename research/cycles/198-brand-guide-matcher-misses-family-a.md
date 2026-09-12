# Cycle 198 — Brand-guide matcher misses Family A path-style Location

**Date:** 2026-09-12T02:55:00Z
**Question:** Cycle 197 next: is `normalizeBrandGuideAsset`
(`agentModeService.ts` L15132) a fourth S3 matcher, and
does Family A path-style `s3.amazonaws.com` miss it?

**Answer:** Yes. `includes('.s3.') && includes('amazonaws.com')`
is **Family B virtual-hosted only**.
`'https://s3.amazonaws.com/bucket/key'.includes('.s3.')`
is **false**. Helpers return SDK `Location`; tests pin
path-style (`s3Utils.test.ts` L53). REST brand **file**
upload writes Family B (`brand.ts` L60–62) so it
matches. Emma `update_brand_guidelines` (`emma/tools.ts`
L2098) accepts any `brandGuide` URL — a `generate_image`
Family A URL would be stamped `filename: 'url'` and a
synthetic `url-brandguide-${Date.now()}` key. Same
repo already has `deriveOwnBucketKey` (`brand.ts`
L84–116) that **does** parse path-style. Tests pin
`example.com` (L230) and never `filename`. Occupied:
`agentModeService.ts` pile — do not edit. Not a
nanoservice. Do not add A-021. Do not un-ready Q-014.

## Evidence

The write-side classifier:

```15128:15141:backend/src/services/agentModeService.ts
      // Normalize a brand guide asset: if the URL is not an S3-hosted file,
      // mark it as a URL entry (filename: "url") so the frontend can display it correctly.
      const normalizeBrandGuideAsset = (asset: any): any => {
        if (asset?.type !== 'brandGuide') return asset;
        const isS3Url = typeof asset.url === 'string' && asset.url.includes('.s3.') && asset.url.includes('amazonaws.com');
        const isUrlEntry = !isS3Url;
        if (isUrlEntry) {
          return {
            ...asset,
            filename: 'url',
            key: asset.key || `url-brandguide-${Date.now()}`,
          };
        }
```

Called for every merged asset (L15291). Logos skip it
(`type !== 'brandGuide'`).

Four matchers, four spellings (cycles 187–191 + this):

| Face | Matcher | Hits Family A path-style? |
|---|---|---|
| Email rewrite | `includes('…s3.us-west-2.amazonaws.com')` | no |
| CORS | `origin ===` Family B host | no (Origin has no path) |
| HTML repair | `includes('agentweb-user-files.s3')` | no |
| **Brand-guide write** | `includes('.s3.')` | **no** |
| Brand **delete** | `deriveOwnBucketKey` L84–116 | **yes** (L109) |

REST file upload never hits this helper — it constructs
Family B:

```60:64:backend/src/routes/brand.ts
  const url = `https://${
    process.env.AWS_S3_BUCKET || "agentweb-user-files"
  }.s3.${process.env.AWS_REGION || "us-west-2"}.amazonaws.com/${key}`;
```

REST `brandGuideUrl` form field already stamps
`filename: "url"` without a matcher (L319–325). The
agentMode helper is a poor copy of that stamp: it
guesses “external” from a substring that misses the
Location `generate_image` returns (`s3Utils.test.ts`
L53). `formatBrandGuidelinesUpdate` L27940 then shows
Emma `Brand Guide: url`.

Delete already extracted the correct decoder because
the old `startsWith` prefix missed path-style (`brand.ts`
L71–80). Write-side Emma did not get that fix.

Tests: `brandGuidelinesUpdate.test.ts` L226–249 uses
`https://example.com/guide.svg` and only asserts
`success`. `__tests__` grep `filename: 'url'` /
`url-brandguide` / `includes('.s3.')` is empty.

## Keep / discard

KEEP the mapping. One persist, one `isOwnBucket` /
`publicUrl` in A-008 after #2. Copying
`deriveOwnBucketKey` onto the write classifier is
in-process, not a fifth `listen()`. Occupied
`agentModeService.ts` (#2871 #2861 #2832 #2563 #2060
#1584 #1076) — do not patch the matcher on a research
turn. Do not add A-021 (same park as cycles 187–191).

## Relation to A-002 / A-007 / A-008

A-008 persist owns one URL writer **and** one decoder.
Until then Emma’s brand-guide “is this S3?” guess
disagrees with the delete path in the same product.
Do not HTTP-split. Do not revive A-006.

## Next cycle candidate

`downloadBrandLogoToS3` URL shape for auto-pinned logos
(L181 / L199) — Family A vs Family B — vs this matcher
(logos skip it). Or Emma `read_brand_guidelines`
L27893 showing `filename`. File-level. Occupied
`agentModeService.ts`. Do not add A-021.
