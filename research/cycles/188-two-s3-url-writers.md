# Cycle 188 — three S3 URL writers, three spellings, same objects

**Date:** 2026-09-12T01:56:00Z
**Question:** Cycle 187: rewrite matches one regional
host. Helpers return SDK `Location`; brand L60
**constructs** a regional virtual-hosted URL. Two
writers, two spellings?

**Answer:** Three writer families, not two. Helpers
and thumbs return whatever `ManagedUpload.Location`
is. Brand / db / tasks / report-revision / blog-repair
interpolate `${bucket}.s3.${region}.amazonaws.com/${key}`.
Remotion interpolates path-style
`s3.${region}.amazonaws.com/${bucket}/…` on purpose.
Zero `s3ForcePathStyle` in `backend/src`, so live SDK
should be virtual-hosted — but helper **tests** mock
global path-style. Rewrite `includes()` one host
(cycle 187) therefore depends on which writer ran.
Not a nanoservice. Do not add A-021.

## Evidence

Family A — return SDK `result.Location`. No
`s3ForcePathStyle` anywhere under `backend/src`.

```281:287:backend/src/utils/s3Utils.ts
    const result = await s3.upload(params).promise();

    return {
      success: true,
      url: result.Location,
      key: result.Key
    };
```

Same return at `uploadFileToS3WithPath` L357–363.
Thumbnail writer uses its own client and still
returns Location (`workPlanThumbnailService.ts`
L29–42). Image persist is Family A:
`imageGeneration.ts` L582–593 `uploadResult.url`.

Helper tests pin that Location as **global
path-style, no region**:

```52:55:backend/src/__tests__/utils/s3Utils.test.ts
      mockUploadPromise.mockResolvedValue({
        Location: 'https://s3.amazonaws.com/test-bucket/users/user-123/files/123/token/test.txt',
        Key: 'users/user-123/files/123/token/test.txt'
```

`extractS3KeyFromUrl` tests accept that spelling
(`s3Utils.test.ts` L340–345). Rewrite L178 would
**miss** it (`includes('…s3.us-west-2.amazonaws.com')`).

Family B — construct regional virtual-hosted after
`putObject` (SDK does not return Location on
PutObject). Same template, seven call sites:

```60:64:backend/src/routes/brand.ts
  const url = `https://${
    process.env.AWS_S3_BUCKET || "agentweb-user-files"
  }.s3.${process.env.AWS_REGION || "us-west-2"}.amazonaws.com/${key}`;
```

| File | Line |
|---|---|
| `brand.ts` | L60–64 |
| `db.ts` | L3005–3006 |
| `tasks.ts` | L1151–1153, L1331–1333 |
| `reportRevisionService.ts` | L477 |
| `agentModeService.ts` | L30469, L30619 |
| `books.ts` | L41–47 (**encodes** each key segment) |

Brand’s own comment (L71–77) already says this
template used to be compared with a hardcoded
`us-west-2` prefix — the delete orphan. Cycle 187
was the email **reader**. This cycle is why that
reader exists: uploads do not share a function.

Family C — Remotion path-style, different bucket,
tests pin the string:

```198:204:backend/src/services/remotionService.ts
export function buildRemotionOutputUrl(
  region: string,
  bucketName: string,
  renderId: string,
  outName: string
): string {
  return `https://s3.${region}.amazonaws.com/${bucketName}/renders/${renderId}/${outName}`;
}
```

`remotionService.handoff.test.ts` L57–66 expects
`https://s3.us-east-1.amazonaws.com/<lambda-bucket>/renders/…`.
That is the third spelling on purpose (mirrors
Remotion `getOutputUrlFromMetadata`). CORS
(`app.ts` L224) allowlists Family B’s host only.

Hermes MEDIA persist is one producer path, one URL
shape. Copying a single `publicUrl(bucket, key)`
(and returning it instead of raw Location) is an
in-process port on A-008 persist, after #2, not
instead of Q-014.

## What this is not

Not a product patch. Do not change URL construction
on a research turn. Do not add A-021.

Not a Q-014 / Q-001 / Q-003 status change. Listing
MCP `generate_image` still returns Family A
(`uploadFileToS3` Location).

Not A-006. HTTP-splitting persist would add a fourth
writer unless every face imported the same helper.

## Relation to A-002 / A-007 / A-008

A-008 persist (after #2) should own one public-URL
builder used by Family B constructors **and** by
helpers instead of leaking SDK Location. Remotion
stays Family C (different bucket, vendor contract).
Do not HTTP-split.

## Next cycle candidate

Family B is still not one function: `books.ts`
L43–47 `encodeURIComponent` per segment; brand / db /
tasks interpolate the raw key. Same host template,
two encodings. CORS L224 is the same one-host as
rewrite. File-level. Do not add A-021.
