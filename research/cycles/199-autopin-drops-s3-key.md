# Cycle 199 — Auto-pin persist is Family A; `auto-logo-*` blocks delete’s URL fallback

**Date:** 2026-09-12T03:10:00Z
**Question:** Cycle 198 next: `downloadBrandLogoToS3` URL
shape for auto-pinned logos — Family A vs Family B —
vs the brand-guide matcher (logos skip it)?

**Answer:** Persist is **Family A**. `downloadBrandLogoToS3`
(`brandLogo.ts` L416–425) calls `uploadFileToS3WithPath`,
which returns SDK `result.Location` (`s3Utils.ts` L357–361).
Helper tests pin path-style (`s3Utils.test.ts` L181–184).
Logos skip the L15132 `.s3.` matcher (`type !== 'brandGuide'`).
The skip-re-pin path **110 lines later** uses the real
`isS3Url()` (`extractS3KeyFromUrl`), which **does** parse
Family A (test L340–345). Auto-pin tests mock Family B
(`brandGuidelinesUpdate.test.ts` L462–463).

The sharper bug: `uploadFileToS3WithPath` also returns
`key: result.Key`. `downloadBrandLogoToS3` **drops it**
and returns only `{ status, url }`. Three mint sites then
stamp `key: auto-logo-${Date.now()}` — the same class as
`url-brandguide-${Date.now()}` for *external* guides, but
here the object **is** in our bucket. Brand delete
(`brand.ts` L693–698) prefers the stored key and only
falls through to `deriveOwnBucketKey` when key is absent.
A synthetic key makes DeleteObject of a nonexistent
object succeed (idempotent) and orphans
`users/{userId}/brand/logo/logo.png`. REST `uploadBrandFile`
(L64) returns the real key, so file-upload logos delete.
Delete tests pin real keys (`OWN_LOGO_KEY` L72) and
keyless URL fallback (L173); `__tests__` grep `auto-logo`
is empty. Occupied: `agentModeService.ts` pile. Not a
nanoservice. Do not add A-021. Do not un-ready Q-014.

## Evidence

Family A persist (same writer as `generate_image`):

```416:425:backend/src/services/agentMode/brandLogo.ts
    const { uploadFileToS3WithPath } = await import('../../utils/s3Utils');
    const uploadResult = await uploadFileToS3WithPath(
      body,
      filename,
      uploadContentType,
      `users/${userId}/brand/logo`,
    );
    if (uploadResult.success && uploadResult.url) {
      console.log(`Logo uploaded to S3: ${uploadResult.url}`);
      return { status: 'uploaded', url: uploadResult.url };
    }
```

The helper already has the object key:

```357:362:backend/src/utils/s3Utils.ts
    const result = await s3.upload(params).promise();

    return {
      success: true,
      url: result.Location,
      key: result.Key
    };
```

Mint (one of three; also L15264 and `brandLogo.ts` L610):

```15196:15202:backend/src/services/agentModeService.ts
            const filename = outcome.url.split('/').filter(Boolean).pop() || 'logo.png';
            autoLogoAsset = {
              type: 'logo',
              url: outcome.url,
              filename,
              key: `auto-logo-${Date.now()}`,
            };
```

Skip-re-pin uses the **imported** helper, not the local
boolean at L15132:

```15241:15244:backend/src/services/agentModeService.ts
        try {
          const { isS3Url } = await import('../utils/s3Utils');
          if (!isS3Url(rawCallerLogoUrl)) {
            const outcome = await downloadBrandLogoToS3(rawCallerLogoUrl, userId);
```

Delete prefers stored key; URL parse is fallback only:

```693:698:backend/src/routes/brand.ts
    let s3Key: string | undefined =
      typeof target.key === "string" && target.key !== "undefined" ? target.key : undefined;
    if (!s3Key && typeof target.url === "string") {
      s3Key = deriveOwnBucketKey(target.url);
    }
```

`deriveOwnBucketKey` L109 already parses Family A
path-style (cycle 198). The synthetic key never lets it
run. REST file upload stores the real key:

```60:64:backend/src/routes/brand.ts
  const url = `https://${
    process.env.AWS_S3_BUCKET || "agentweb-user-files"
  }.s3.${process.env.AWS_REGION || "us-west-2"}.amazonaws.com/${key}`;

  return { url, key };
```

Same function, two classifiers:

| Face | Classifier | Hits Family A? |
|---|---|---|
| Brand-guide write L15132 | local `includes('.s3.')` | **no** |
| Logo skip-re-pin L15242 | `s3Utils.isS3Url` | **yes** |
| Brand delete L84 | `deriveOwnBucketKey` | **yes**, if key absent |
| Brand delete L693 | stored `attachment.key` | `auto-logo-*` is not the object |

Cycle 197 character portraits: empty key → skip
`deleteObject`. Auto-pin is worse: a **fake** key that
looks set. `url-brandguide-*` is correct for external
guides (no object). Copying that pattern onto a Family A
object is the orphan.

Hermes `image_generation_tool.py` keeps one persist
result. A-008 persist (after #2) should return
`{url, key}` and store `result.Key`. Do not HTTP-split.
Do not patch `brandLogo.ts` / `agentModeService.ts` /
`brand.ts` on a research turn.

## Relation to A-002 / A-007 / A-008

A-008 persist owns one writer **and** one stored key.
Until then Emma auto-pin and REST file upload disagree
on what `attachments[].key` means. Do not revive A-006.

## Next cycle candidate

`classifyBrandLogoUrl` (`brandLogo.ts` L483) is Path C
axios GET of the persisted Family A URL (ENG-792).
After auto-pin, `ensureBrandLogoPersisted` L654 probes
that URL. 4xx → `'broken'` → re-scrape. No `isS3Url` /
`presignS3Url`. File-level. Or Emma `read_brand_guidelines`
L27884 showing `filename`. Occupied `agentModeService.ts`
for the mint; `brandLogo.ts` is the probe. Do not add A-021.
