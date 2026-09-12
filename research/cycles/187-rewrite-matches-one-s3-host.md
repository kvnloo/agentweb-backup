# Cycle 187 — email rewrite matches one S3 host; `/asset/` accepts three

**Date:** 2026-09-12T01:52:00Z
**Question:** Cycle 186: email `rewriteS3ImageUrls`
hops `/asset/`. Does that rewrite match the same
URLs `decodeAssetHash` can serve?

**Answer:** No. Rewrite is `String.includes` of one
hardcoded host
(`agentweb-user-files.s3.us-west-2.amazonaws.com`,
`emailVariables.ts` L178). `decodeAssetHash` uses
`extractS3KeyFromUrl` against **two** buckets and
**both** regional and region-less virtual-hosted
hosts (plus path-style). Brand delete already hit this
and **extracted a bucket matcher** (`brand.ts` L67–80
/ L84–116). Email rewrite did not copy it. Not a
nanoservice. Do not add A-021.

## Evidence

Rewrite gate is a constant, not `extractS3KeyFromUrl`:

```178:193:backend/src/utils/emailVariables.ts
const S3_BUCKET_HOST = 'agentweb-user-files.s3.us-west-2.amazonaws.com';
...
      if (!srcUrl.includes(S3_BUCKET_HOST)) return _match;
```

`/asset/` allowlist is a Set of **bucket names**:

```13:16:backend/src/controllers/assetController.ts
const ALLOWED_BUCKETS = new Set([
  process.env.AWS_S3_BUCKET || "agentweb-user-files",
  "agentweb-execution-gifs",
]);
```

`decodeAssetHash` walks that set through
`extractS3KeyFromUrl` (`s3Utils.ts` L19–40):
`bucket.s3.amazonaws.com`, `bucket.s3.<region>`,
path-style `s3.amazonaws.com/bucket/key`. Tests pin
all three:

| URL | `decodeAssetHash` | rewrite |
|---|---|---|
| `…s3.us-west-2.amazonaws.com/…` (test L20) | yes | **yes** (only fixture in `emailVariables.test.ts` L254) |
| `…s3.amazonaws.com/…` (test L10) | yes | **no** (`includes` misses) |
| `agentweb-execution-gifs.s3.amazonaws.com/…` (test L30) | yes | **no** (wrong bucket) |

Helpers return SDK `result.Location` (`s3Utils.ts`
L285), not a constructed regional URL. `s3Utils.test.ts`
mocks `https://s3.amazonaws.com/test-bucket/…`
(path-style, no region) — that string would also miss
L178. Brand **already documented** the delete-side
version of this lie:

```71:80:backend/src/routes/brand.ts
 * This used to be a `startsWith` against a hardcoded
 * `https://<bucket>.s3.us-west-2.amazonaws.com/` prefix, while uploads build
 * their URL from `process.env.AWS_REGION`. Any deployment not in us-west-2
 * therefore wrote URLs its own delete path could not parse... Path-style
 * and region-less URLs failed the same way.
 *
 * Matching on the bucket rather than on one spelling of its hostname covers
```

`deriveOwnBucketKey` L84–116 is that matcher. Email
rewrite is the pre-fix `startsWith`. Comment L184
says “Only rewrites src attributes pointing to the
agentweb-user-files S3 bucket” — the code points at
one hostname spelling, not the bucket.

`emailVariables.test.ts` L253–312 never uses the
region-less host `assetController.test.ts` L10
already treats as valid. The 300s hop (cycle 186)
only runs when the substring hits. Misses leave raw
S3 in the email — the WeChat/Gmail reason `/asset/`
exists (`emailVariables.ts` L180–182;
`user-release.ts` L4231).

Hermes MEDIA delivery uses one producer path, not
three host catalogs. Copying `deriveOwnBucketKey` /
`extractS3KeyFromUrl` onto the rewrite is an
in-process port, not a fifth `listen()`.

## What this is not

Not a product patch. Do not change the rewrite on a
research turn. Do not add A-021.

Not a Q-014 / Q-001 / Q-003 status change. Listing MCP
`generate_image` does not unify S3 host matchers.

Not A-006. HTTP-splitting `/asset/` would still leave
the email face on the hardcoded host.

## Relation to A-002 / A-007 / A-008

A-008 persist (after #2, not instead of Q-014) should
export one “is our bucket URL” helper and use it from
rewrite, `/asset/`, and brand delete. Brand already
has the function. Do not HTTP-split.

## Next cycle candidate

Helpers return SDK `Location`; brand L60–64
**constructs**
`https://${bucket}.s3.${region}.amazonaws.com/${key}`.
Two writers, two URL spellings, same bucket. File-level.
Do not add A-021.
