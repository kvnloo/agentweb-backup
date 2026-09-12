# Cycle 189 — Family B is not one function: encode vs raw key

**Date:** 2026-09-12T02:01:00Z
**Question:** Cycle 188: Family B interpolates
`${bucket}.s3.${region}.amazonaws.com/${key}`. Is
that one function, or do call sites still disagree
on the path?

**Answer:** Two constructors, two encodings, same
host template. `books.ts` percent-encodes each key
segment (twice). Brand / db / tasks interpolate
`file.originalname` raw into the URL. Helpers never
need encoding because they sanitize the key first.
The two in-process extractors disagree on
`decodeURIComponent`. Not a nanoservice. Do not add
A-021.

## Evidence

Books encodes the URL, keeps the unencoded key:

```40:49:backend/src/controllers/books.ts
  // Properly encode the URL by encoding each path segment
  const bucket = process.env.AWS_S3_BUCKET || "agentweb-user-files";
  const region = process.env.AWS_REGION || "us-west-2";
  const encodedKey = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const url = `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;
```

Same block at L1810–1814 (exports). The Key still
embeds `file.originalname` unsanitized (L27–29).

Brand uses the same host template **without**
encoding:

```47:64:backend/src/routes/brand.ts
  const key = `users/${userId}/brand/${fileType}/${Date.now()}-${randomToken}-${
    file.originalname
  }`;
  ...
  const url = `https://${
    process.env.AWS_S3_BUCKET || "agentweb-user-files"
  }.s3.${process.env.AWS_REGION || "us-west-2"}.amazonaws.com/${key}`;
```

`db.ts` L2991–3006 and `tasks.ts` L1140 / L1151–1153
are the same raw-`originalname` interpolation.
`reportRevisionService.ts` L477 and
`agentModeService.ts` L30469 / L30619 interpolate a
key they already built (no `originalname`), still
unencoded.

Family A never puts those characters in the key:

```248:265:backend/src/utils/s3Utils.ts
    const sanitizedFilename = normalizedFilename
      .replace(/[^a-zA-Z0-9.-]/g, '_')
      .replace(/\s+/g, '_');
    ...
    const key = `users/${userId}/files/${Date.now()}/${randomToken}/${sanitizedFilename}`;
```

Test L83–94 feeds `'file name with spaces!@#$.txt'`
and the mock Key is `file_name.txt`. Image persist
(cycle 188 Family A) inherits that.

The extractors then split:

| Helper | Decode? | Callers |
|---|---|---|
| `deriveOwnBucketKey` L97 | **yes** `decodeURIComponent` | brand delete |
| `extractS3KeyFromUrl` L27 | **no** — `pathname` as stored | `filesController.ts` L36, `assetController`, `inlineS3Images` |

A books URL for `My File.pdf` stores
`…/token-My%20File.pdf` while the S3 Key has a space.
`extractS3KeyFromUrl` returns the encoded string;
`getS3ObjectMetadata` then HEADs the wrong key.
Brand delete would recover the real key. No books
test pins `encodedKey`. Brand delete tests pin
host spellings (L726–730), not `%20`.

CORS (`app.ts` L224) is Origin **equality** on Family
B’s host — path encoding never reaches `Origin`.
That is the same one-host class as rewrite (cycle
187), not this encoding split.

Hermes MEDIA persist is one producer, one encoding.
Copying books’ encoder (or Family A’s sanitizer)
into a shared `publicUrl(bucket, key)` is A-008
persist after #2, not instead of Q-014.

## What this is not

Not a product patch. Do not change URL encoding on a
research turn. Do not add A-021.

Not a Q-014 / Q-001 / Q-003 status change. MCP
`generate_image` persist is Family A (sanitized).

Not A-006. HTTP-splitting persist would still need one
encoder.

## Relation to A-002 / A-007 / A-008

A-008 persist should own **one** of: sanitize like
`s3Utils`, or encode like books, plus **one**
extractor that decodes. `deriveOwnBucketKey` already
decodes. Do not HTTP-split.

## Next cycle candidate

CORS `app.ts` L224 is exact-string Origin
`https://agentweb-user-files.s3.us-west-2.amazonaws.com`.
Family A tests mock path-style Location whose Origin
would miss. File-level. Do not add A-021.
