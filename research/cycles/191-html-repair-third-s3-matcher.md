# Cycle 191 — HTML repair is a third S3 matcher; same class already has the parser

**Date:** 2026-09-12T02:12:00Z
**Question:** Cycle 190: HTML repair
`includes('agentweb-user-files.s3')` at
`agentModeService.ts` L30399–30428 is a third
matcher. Same class as rewrite/CORS, or does the
method already own a better parser?

**Answer:** Third matcher, five sites, one
method (`repairBlogArticle` L30291). Hardcoded
**production** bucket substring — not
`AWS_S3_BUCKET`. The same class already imports
`extractS3KeyFromUrl` (L453) and uses it at
L28635 to SDK-stream private objects. Same method
then **writes** Family B with the env bucket
(L30469 / L30619). Tests set `test-bucket` and
never pin `totalImagesChecked`. Not a
nanoservice. Do not add A-021.

## Evidence

Five substring gates in Step 2, then Family B
writers in Steps 4 and resize:

```30397:30429:backend/src/services/agentModeService.ts
      while ((match = heroImageRegex1.exec(htmlContent)) !== null) {
        const imgUrl = match[1];
        if (imgUrl.includes('agentweb-user-files.s3')) {
          allImages.add(imgUrl);
```

Same `includes` at L30407, L30415 (og:image),
L30420 (twitter:image), L30428 (all `<img src>`).
Then:

```30462:30469:backend/src/services/agentModeService.ts
      await s3.putObject({
        Bucket: process.env.AWS_S3_BUCKET || 'agentweb-user-files',
        Key: htmlKey,
        Body: htmlContent,
        ContentType: 'text/html',
      }).promise();

      repairResults.repairedArticleUrl = `https://${process.env.AWS_S3_BUCKET || 'agentweb-user-files'}.s3.${process.env.AWS_REGION || 'us-west-2'}.amazonaws.com/${htmlKey}`;
```

Resize upload is the same constructor (L30612–30619).
**Writer uses env. Reader hardcodes prod.** A
dev/test bucket named anything except
`agentweb-user-files` uploads a repaired HTML
whose own images this method will not collect.

The in-process parser is already in this file:

```28631:28638:backend/src/services/agentModeService.ts
      // Fetch the file content — S3 objects are private, use SDK directly for our bucket
      const s3Key = extractS3KeyFromUrl(normalizedFileUrl);
      if (s3Key) {
        // Private bucket object — stream via SDK (same pattern as filesController)
        const stream = getS3ObjectStream(s3Key);
```

`extractS3KeyFromUrl` (`s3Utils.ts` L19–48) parses
hostname: regional + region-less virtual-hosted
**and** path-style. Default bucket is
`process.env.AWS_S3_BUCKET` (L11). Tests pin
path-style (`s3Utils.test.ts` L340–346) and
reject a bucket-lookalike host (L364–368).
`includes('agentweb-user-files.s3')` hits
`https://agentweb-user-files.s3.evil.example/x`
and misses `https://s3.amazonaws.com/agentweb-user-files/key`.

| Face | Matcher | Bucket | Path-style Family A / C |
|---|---|---|---|
| Email rewrite (187) | `includes(S3_BUCKET_HOST)` | hardcoded `…s3.us-west-2…` | miss |
| CORS (190) | `origin ===` | hardcoded regional origin | miss (Origin is `s3.amazonaws.com`) |
| HTML repair (this) | `includes('agentweb-user-files.s3')` | hardcoded prod name, region-less | miss |
| `extractS3KeyFromUrl` | hostname parse | env `DEFAULT_BUCKET` | hit |
| `deriveOwnBucketKey` | bucket on host or path | env | hit |

Repair is **wider than CORS/rewrite** (region-less
`bucket.s3.amazonaws.com` matches) and **narrower
than the parser already imported here**
(path-style still misses). Brand delete already
documented this lie (`brand.ts` L71–80) and
extracted the matcher.

Callers: Emma `repair_blog_article`
(`emma/tools.ts` L2775–2795) and
`POST /repair-blog` (`emmaApi.ts` L887–897).
`#2832` occupies `emma/tools.ts`; do not patch
the tool wrapper on a research turn.

## Tests never pin the matcher

`agentModeService.repairBlogArticle.test.ts` L42–51:

```
process.env.AWS_S3_BUCKET = 'test-bucket';
<img src="https://test-bucket.s3.us-west-2.amazonaws.com/hero.png"
```

That src **fails** `includes('agentweb-user-files.s3')`.
Grep of the file for `totalImagesChecked` /
`agentweb-user-files` is empty. The suite is
structure-only (`div.content`). It cannot catch
the writer/reader split it itself constructs.

## What this is not

Not a product patch. Do not change the matcher,
CORS, or URL construction on a research turn.
Do not add A-021. Occupied: `agentModeService.ts`
pile; `app.ts` #2271.

Not a Q-014 / Q-001 / Q-003 status change. MCP
`generate_image` persist is Family A Location;
repair’s collect step is a different catalog.

Not A-006. HTTP-splitting blog repair would still
need one host parser on whichever process fetches
the HTML. The parser is already in-process
(`isS3Url` / `extractS3KeyFromUrl`). Copying it
onto `repairBlogArticle` is A-008 persist (one
`publicUrl` + one decoder), after #2, not
instead of Q-014.

## Relation to A-002 / A-007 / A-008

A-008 persist should emit one public URL shape
and one decoder. Until then, `repairBlogArticle`
is writer+reader in one method with two catalogs.
Do not HTTP-split. Do not revive A-006.

## Next cycle candidate

`repairBlogArticle` `axios.get`s `articleUrl`
(L30316) with **no** host check. `checkAndResizeImage`
then `axios.get`s each matched image (L30547)
instead of `getS3ObjectStream`. Same file already
documents that S3 objects are private (L28631).
File-level. Do not add A-021.
