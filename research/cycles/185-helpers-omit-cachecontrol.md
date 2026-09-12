# Cycle 185 — helpers omit `CacheControl`; README’s 60s is a CLI ritual

**Date:** 2026-09-12T01:46:00Z
**Question:** Cycle 184: user metadata is write-only.
Does the shared helper set the **system** header
CloudFront is documented to honor?

**Answer:** No. `uploadFileToS3` L269–279 and
`uploadFileToS3WithPath` L345–355 omit `CacheControl`.
The HTML-form save path (`filesController.ts` L379)
is the README’s subject and still omits it. Root
README L1537 lists `Cache-Control: max-age=60` as
**Required System-Defined Metadata**; the only setter
in that section is a **manual** `aws s3api copy-object`
(L1546–1555), not the helper. The thumbnail writer is
again the one-off that tells the truth (L35,
immutable 1y). Not a nanoservice. Do not patch S3.

## Evidence

Shared helper PutObject params are Bucket, Key, Body,
ContentType, Metadata. No `CacheControl`:

```269:279:backend/src/utils/s3Utils.ts
    const params = {
      Bucket: bucket,
      Key: key,
      Body: content,
      ContentType: contentType,
      Metadata: {
        'original-filename': asciiMetadataFilename,
        'uploaded-by': 'agent-mode',
        'upload-timestamp': new Date().toISOString()
      }
    };
```

`uploadFileToS3WithPath` L345–355 is the same shape.
Grep of `backend/src/**/*.ts` for `CacheControl` as
an S3 upload field is **one line**:
`workPlanThumbnailService.ts` L35
`public, max-age=31536000, immutable`.

The lead-form save is that second helper:

```379:384:backend/src/controllers/filesController.ts
    const uploadResult = await uploadFileToS3WithPath(
      content,
      filename,
      "text/html",
      path
    );
```

README L1533–1560 (and the curl receipt L1682, the
stale-content note L1712–1713, CloudFront TTL L1577
“Respect origin headers (max-age=60 from S3)”) assume
the object already has `max-age=60`. The code path
that writes the object never sets it. The CLI
`copy-object --cache-control "max-age=60"` is an
operator ritual after the fact. `s3Utils.test.ts`
grep `CacheControl` is empty.

Express faces do not fill the gap:

| Face | What it sends |
|---|---|
| `filesController.ts` L39–44 | `ContentType` + `ContentLength` only (cycle 184) |
| `serveAsset` L124 | **hardcoded** `public, max-age=300` on the HTTP response; ignores `headResult.CacheControl` |

CloudFront Functions for URL rewrite are a README
snippet (L1596–1607) with a placeholder key. Glob
`**/*cloudfront*` in this tree is empty (same class as
cycle 119’s unvendored nginx.conf). Live TTL is
live-AWS-only once origin headers are missing.

Cycle 182 orphans and onboarding ads also go through
`uploadFileToS3` (`imageGeneration.ts` L582) with no
object `CacheControl`. Hermes persist and delivery
are the same process — no CloudFront “honor origin
Cache-Control” contract the helper can fail. Copying
the thumbnail’s `CacheControl` argument onto the
shared helper is an in-process port, not a fifth
hop.

## What this is not

Not a product patch. Do not add `CacheControl` on a
research turn. Do not add A-021.

Not a Q-014 / Q-001 / Q-003 status change. Listing MCP
`generate_image` does not set origin cache headers.

Not A-006. HTTP-splitting the leaf would still omit
`CacheControl` unless the helper grew the argument
the thumbnail path already uses.

## Relation to A-002 / A-007 / A-008

A-008 persist (after #2, not instead of Q-014) should
take a caller `CacheControl` (HTML 60s vs thumbnails
immutable vs default omit), same as cycle 183’s
caller tag. Do not HTTP-split S3. Do not vendor a
CloudFront Function instead of Q-014.

## Next cycle candidate

`serveAsset` L124 always `max-age=300` and never
forwards `headResult.CacheControl`. Even the
thumbnail’s immutable 1y object, if streamed through
`/asset/:hash`, becomes 5 min. `filesController`
stream same omission. Reader-side of cycle 185.
File-level. Do not add A-021.
