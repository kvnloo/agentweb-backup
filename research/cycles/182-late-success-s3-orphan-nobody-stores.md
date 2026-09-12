# Cycle 182 — late Gemini success S3-uploads a key nobody stores

**Date:** 2026-09-12T01:35:00Z
**Question:** Cycle 181: if the vendor returns between 180s
and 8 min, meter still fires. Does that path also persist
an S3 object the User record never points at?

**Answer:** Yes for onboarding’s Gemini 3 data URLs.
Cycle 174’s HTTPS skip does **not** apply. After meter
L551, C2PA L575–578 and `uploadFileToS3` L582–587 still
run. Key is `users/{userId}/files/{ts}/{token}/{filename}`.
`s3Utils.ts` has **zero** `DeleteObject`. The race already
returned `placeholder://ad-image-failed`. ENG-792 only
fails the run when **all** variants are placeholders.
Not a nanoservice. Do not patch billing.

## Evidence

Gemini 3 returns `data:image/png;base64,...` (L1101).
Onboarding pins that model (cycle 180). Late success
therefore takes L566–587, not the L570–572 URL skip:

```581:587:backend/src/services/imageGeneration.ts
          const uploadResult = await uploadFileToS3(
            imageBuffer,
            result.filename || params.filename,
            params.userId,
            'image/png'
          );
```

```264:276:backend/src/utils/s3Utils.ts
    const key = `users/${userId}/files/${Date.now()}/${randomToken}/${sanitizedFilename}`;
    ...
        'uploaded-by': 'agent-mode',
```

Filename from onboarding L656:
`ad-image-${userId}-${i + 1}-${Date.now()}.png`. Orphans
look like normal user files. Metadata still says
`uploaded-by: agent-mode`. Grep of `s3Utils.ts` for
DeleteObject/deleteObject/lifecycle/Expiration is empty.

`generateWithTimeout` already resolved the placeholder
(L676–677). Nothing patches the User with
`uploadResult.url`. ENG-792 L1100–1111 fails only when
`liveCount === 0`; a 2-live + 1-timeout run stays
**ready** while the third object still lands in the
bucket after the patch.

C2PA default-on (cycle 36) still re-encodes the discarded
buffer. Tests inject a fake generator (L375–408) and
never call `uploadFileToS3`.

Hermes persist is in-process with the same call that
the loop keeps. A fifth HTTP hop would still upload
unless the port grew `AbortSignal` (cycle 181).

## What this is not

Not a product patch. Do not add S3 GC on a research
turn. Do not change `meterUserUsage`. Do not add A-021.

Not a Q-014 / Q-001 / Q-003 status change. Listing MCP
`generate_image` does not TTL user-files keys.

Not A-006. HTTP-splitting the leaf would still upload
unless cancel exists.

## Relation to A-002 / A-007 / A-008

A-008 leaf should skip S3 when the caller already
abandoned the promise, or accept `AbortSignal` before
L551. After #2, not instead of Q-014.

## Next cycle candidate

`uploadFileToS3` L276 always sets `'uploaded-by':
'agent-mode'` including onboarding ads and orphans.
Provenance lie, one helper. File-level. Do not add A-021.
