# Cycle 186 — `serveAsset` hardcodes `max-age=300`; never forwards object `CacheControl`

**Date:** 2026-09-12T01:49:00Z
**Question:** Cycle 185: helpers omit object
`CacheControl`; thumbnail L35 is immutable 1y.
Do Express faces **forward** that header if it
exists?

**Answer:** No. `serveAsset` HEADs the object (L117)
then **overwrites** with `public, max-age=300`
(L124). `headResult.CacheControl` is never read
(grep of `backend/src` for that field is empty
outside the thumbnail PutObject). The live caller
is email: `rewriteS3ImageUrls` (`emailVariables.ts`
L187–197) rewrites S3 `<img src>` to
`${BACKEND_URL}/asset/<hash>`. Drip
(`dripSequenceWorker.ts` L187) and sequences
(`sequences.ts` L353) both hop here. Not a
nanoservice. Do not patch headers.

## Evidence

HEAD already ran. The next line invents a TTL:

```116:124:backend/src/controllers/assetController.ts
  try {
    const headResult = await s3.headObject({ Bucket: parsed.bucket, Key: parsed.key }).promise();
    const contentType = headResult.ContentType || "text/html; charset=utf-8";
    res.setHeader("Content-Type", contentType);
    if (headResult.ContentLength) {
      res.setHeader("Content-Length", headResult.ContentLength);
    }
    res.setHeader("Cache-Control", "public, max-age=300");
```

Comment L123: “Cache for 5 minutes to reduce S3 load.”
That is a proxy TTL, not the object’s. A README CLI
`copy-object --cache-control max-age=60` (cycle 185)
would still leave `/asset/` at 300s. Thumbnail
immutable 1y would also become 5 min **if** this hop
ran.

It does not run for work-plan thumbs. Partner portal
uses the raw S3 URL:

```821:824:partner-portal/src/pages/WorkPlans.tsx
                      {plan.thumbnail_url ? (
                        <Box
                          component="img"
                          src={plan.thumbnail_url}
```

Email is the hop that does:

```187:196:backend/src/utils/emailVariables.ts
export function rewriteS3ImageUrls(html: string, baseUrl: string): string {
  ...
      if (!srcUrl.includes(S3_BUCKET_HOST)) return _match;
      const hash = Buffer.from(srcUrl).toString('base64')...
      return `${prefix}${base}/asset/${hash}${suffix}`;
```

Route is public (`app.ts` L505–506, no
`authenticateToken`). Generated images
(`imageGeneration.ts` L582, helper omits
`CacheControl`) that land in drip HTML get a 5 min
browser/CDN TTL invented here, not from S3.

`filesController.ts` L39–44 is a third face: copies
`ContentType` / `ContentLength`, sets **no**
`Cache-Control` at all. Three Express/S3 cache
policies, no port:

| Face | Cache-Control |
|---|---|
| S3 PutObject (helpers) | omitted (cycle 185) |
| S3 PutObject (thumbnail) | immutable 1y |
| CloudFront (README) | assume origin 60s |
| `GET /asset/:hash` | hardcoded 300s |
| `filesController` stream | unset |

`assetController.test.ts` never imports `serveAsset`
— only `decodeAssetHash` / `trackVisit` / `hashIp`.
The 300s is unasserted. Email rewrite tests pin the
URL shape, not the response header.

Hermes MEDIA delivery is the gateway attaching the
file. There is no second HTTP proxy that invents a
TTL after persist. Copying `headResult.CacheControl`
(or a caller TTL) onto `serveAsset` is an in-process
header map, not a fifth `listen()`.

## What this is not

Not a product patch. Do not change `/asset/` TTL on
a research turn. Do not add A-021.

Not a Q-014 / Q-001 / Q-003 status change. Listing MCP
`generate_image` does not forward origin cache
headers through the email proxy.

Not A-006. HTTP-splitting images would add a sixth
TTL unless the proxy grew the same map.

## Relation to A-002 / A-007 / A-008

A-008 persist (after #2, not instead of Q-014)
should own one cache policy per caller and have the
`/asset/` proxy **forward** it. Do not HTTP-split
the public hash route.

## Next cycle candidate

`rewriteS3ImageUrls` matches only
`agentweb-user-files.s3.us-west-2.amazonaws.com`
(L178). `decodeAssetHash` accepts non-regional hosts
and `agentweb-execution-gifs`. `upload` `Location`
may not include the region. Emails with those URLs
never hop `/asset/`. File-level. Do not add A-021.
