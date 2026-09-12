# Cycle 184 — no production reader filters on `uploaded-by`

**Date:** 2026-09-12T01:45:00Z
**Question:** Cycle 183: both S3 helpers hardcode
`'uploaded-by': 'agent-mode'`; the thumbnail writer
tells the truth. Does any runtime path **read** that
tag?

**Answer:** No. The stamp is write-only. Production
`headObject` callers use `ContentType` /
`ContentLength` only. `assetController.ts` **imports**
`getS3ObjectMetadata` and never calls it — it HEADs
with its own client for the same two system headers.
Cycle 182 orphans cannot be found by querying the
tag: nothing queries it, and even a truthful value
is not list-filterable (S3 user metadata; helpers
set no `Tagging`). Not a nanoservice. Do not add
A-021.

## Evidence

Repo-wide grep of `'uploaded-by'` / `x-amz-meta-uploaded`
outside `research/` is **three writers** plus the
operator README:

| Site | Role |
|---|---|
| `s3Utils.ts` L276 / L352 | writers (constant `agent-mode`) |
| `workPlanThumbnailService.ts` L37 | writer (`workplan-thumbnails`) |
| root `README.md` L1542 / L1554 | CLI `copy-object` example, not a reader |

`getS3ObjectMetadata` (`s3Utils.ts` L106–108) returns
the full HeadObject, including `Metadata`. Callers
discard that bag:

```28644:28646:backend/src/services/agentModeService.ts
        try {
          const meta = await getS3ObjectMetadata(s3Key);
          contentType = meta.ContentType || '';
```

```39:44:backend/src/controllers/filesController.ts
        const metadata = await getS3ObjectMetadata(s3Key, DEFAULT_BUCKET);
        const contentType = metadata.ContentType || "text/html; charset=utf-8";
        res.setHeader("Content-Type", contentType);
        if (metadata.ContentLength) {
          res.setHeader("Content-Length", metadata.ContentLength);
```

Same at `filesController.ts` L307–308 (`ContentType`
only). `original-filename` and `upload-timestamp`
(the other two helper keys) have **zero** production
readers either — grep of those strings is the writers
only.

`assetController.ts` L3 imports `getS3ObjectMetadata`
and never uses it. L117 HEADs with a **second**
`AWS.S3` client:

```117:124:backend/src/controllers/assetController.ts
    const headResult = await s3.headObject({ Bucket: parsed.bucket, Key: parsed.key }).promise();
    const contentType = headResult.ContentType || "text/html; charset=utf-8";
    res.setHeader("Content-Type", contentType);
    if (headResult.ContentLength) {
      res.setHeader("Content-Length", headResult.ContentLength);
    }
    res.setHeader("Cache-Control", "public, max-age=300");
```

HEAD is for streaming MIME, not provenance. The unused
import is the receipt.

Tests: `s3Utils.test.ts` L554 mocks
`{ ContentType: 'text/html', ContentLength: 1234 }`.
Upload tests (L57+, L186+) never expect
`params.Metadata`.

S3 user-defined metadata is not a ListObjects filter.
Helpers have **zero** `Tagging` / `TagSet`
(`s3Utils.ts` grep empty). Cycle 182’s
`users/{userId}/files/...` orphans share the same
constant as live Agent Mode files; a future GC job
cannot `ListObjects` by `uploaded-by`. Hermes MEDIA
tags are **read** by the gateway to deliver files.
AgentWeb stamps metadata nobody reads.

## What this is not

Not a product patch. Do not add S3 Inventory, object
tags, or a Metadata reader on a research turn. Do not
add A-021.

Not a Q-014 / Q-001 / Q-003 status change. Listing MCP
`generate_image` does not create a consumer of the
tag.

Not A-006. A fifth HTTP hop would still HEAD
`ContentType` and ignore `Metadata`.

## Relation to A-002 / A-007 / A-008

A-008 persist (after #2, not instead of Q-014) should
either drop the unused constant or grow a caller tag
**and** a reader (GC, ACL, or listing). Stamping a
value nobody reads is not a package boundary. The
thumbnail’s truthful tag is equally unread.

## Next cycle candidate

Helpers omit `CacheControl`; thumbnail L35 sets
`public, max-age=31536000, immutable`. Root README
L1537 wants HTML forms `max-age=60`. `serveAsset`
sets 5 min on the **HTTP** response (L124), not on
the object. Three cache policies, helpers set none.
File-level. Do not add A-021.
