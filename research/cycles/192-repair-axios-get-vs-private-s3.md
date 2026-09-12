# Cycle 192 — Blog repair `axios.get`s S3; same class already has SDK and presign

**Date:** 2026-09-12T02:15:00Z
**Question:** Cycle 191: `repairBlogArticle` matches with a
substring then what? Does it fetch via the private-S3
path this class already owns?

**Answer:** No. Article download L30316 and image
download L30547 are bare `axios.get`. Same class already
has two private-S3 paths: `extractS3KeyFromUrl` +
`getS3ObjectStream` (`read_file_content` L28631) and
`isS3Url` + `presignS3Url` then axios (`describe_image`
L9327; LinkedIn MEDIA L38291). `filesController.ts` L35
documents the SDK path as “no public access needed.”
Repair uses neither. Not a nanoservice. Do not add A-021.

## Evidence

Step 1 fetches whatever Emma passed, no host check
and no parser:

```30314:30322:backend/src/services/agentModeService.ts
      // Step 1: Download and parse HTML
      console.log('AgentMode: Downloading HTML article...');
      const htmlResponse = await axios.get(articleUrl, {
        timeout: 30000,
        responseType: 'text',
        headers: {
          'User-Agent': 'AgentWeb-Backend/1.0',
        },
      });
```

Matched images (cycle 191 substring) then:

```30545:30550:backend/src/services/agentModeService.ts
      // Download image from S3
      console.log('AgentMode: Downloading image from S3:', imageUrl);
      const imageResponse = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });
```

Comment says “from S3.” Call is HTTP GET of the URL
string. No `presignS3Url`. No `getS3ObjectStream`.
The import at L453 already has both.

**Path A — SDK, own bucket, no public GET:**

```28631:28638:backend/src/services/agentModeService.ts
      // Fetch the file content — S3 objects are private, use SDK directly for our bucket
      const s3Key = extractS3KeyFromUrl(normalizedFileUrl);
      if (s3Key) {
        // Private bucket object — stream via SDK (same pattern as filesController)
        const stream = getS3ObjectStream(s3Key);
```

`filesController.ts` L35: “stream directly via SDK (no
public access needed).” `db.ts` L2994: “Upload to S3
without ACL setting.” Helpers (`s3Utils.ts` L269–279)
also omit ACL.

**Path B — presign, then axios, still this class:**

```9327:9330:backend/src/services/agentModeService.ts
          // For private S3 URLs from our bucket, generate a presigned URL so the download succeeds
          const { presignS3Url, isS3Url } = await import('../utils/s3Utils');
          const isOwnS3 = isS3Url(imageUrl);
          const fetchUrl = isOwnS3 ? (presignS3Url(imageUrl) ?? imageUrl) : imageUrl;
```

LinkedIn MEDIA L38291–38298 is the same helper
copied again: “direct S3 access requires a presigned
URL.”

**Path C — bare axios:** repair L30316 / L30547.
Siblings in this file: `removeC2PAFromImage` L29538,
`removeImageBackground` L29660, `uploadMetaAdsImage`
L19850. Next-cycle candidates, not this cycle’s
claim.

Gemini `describe_image` comment L9302–9304 says
some screenshot URLs **are** fetchable in prod
(100+ sessions). Cycle 190’s CORS Origin exists
because browsers open Emma HTML reports as raw S3.
So Path C is not “always 403.” It is the path that
**fails when the object is private**, which this
file already treats as the default for our bucket.
Repair tests mock `axios.get` and never pin a 403.

`isS3Url` (`s3Utils.ts` L92) is `extractS3KeyFromUrl
!== null`. Repair’s matcher (cycle 191) is a
different catalog, so a path-style URL that Path A
would SDK-stream never reaches Path C’s image GET
either.

## What this is not

Not a product patch. Do not change fetch, CORS, or
the matcher on a research turn. Do not add A-021.
Occupied: `agentModeService.ts` pile.

Not a Q-014 / Q-001 / Q-003 status change. MCP
`generate_image` persist is Family A Location; how
blog repair reads that URL is a different hop.

Not A-006. HTTP-splitting repair would still need
Path A or B on whichever process fetches. Copying
`getS3ObjectStream` onto `repairBlogArticle` is
A-008 persist (one decoder + one fetch), after #2,
not instead of Q-014.

## Relation to A-002 / A-007 / A-008

A-008 persist should own `publicUrl` + decoder +
fetch-own-bucket. Until then this class has three
read catalogs. Do not HTTP-split. Do not revive
A-006.

## Next cycle candidate

`removeC2PAFromImage` L29538 and
`removeImageBackground` L29660 are the same Path C
on Emma image tools (cycle 174 already noted
`remove_c2pa` downloads HTTP). File-level. Or
articleUrl L30316 has no host allowlist (SSRF vs
`extractS3KeyFromUrl` first). Do not add A-021.
