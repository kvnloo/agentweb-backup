# Cycle 190 — CORS Origin is exact Family B host; tests never pin it

**Date:** 2026-09-12T02:05:00Z
**Question:** Cycle 189: CORS `app.ts` L224 is the
same host string as rewrite. Is it the same
matcher?

**Answer:** No. Rewrite is `String.includes` on a
full URL. CORS is `origin ===` one HTTPS origin
(`app.ts` L256) with **`credentials: true`**.
`cors.test.ts` pins hireemma / ngrok and never the
S3 string. CloudFront forms already match
`*.agentwebforms.com` (L220). L224 is only the
raw-S3 HTML Origin. Path-style Family A Location
and region-less virtual-hosted Origins miss.
Not a nanoservice. Do not add A-021.

## Evidence

S3 is the only AWS origin in the allowlist, and
it is a string literal next to regexes:

```218:226:backend/src/app.ts
    const allowedOrigins = [
      /^https:\/\/[a-zA-Z0-9\-]+\.agentweb\.pro$/,
      /^https:\/\/[a-zA-Z0-9\-]+\.agentwebforms\.com$/,
      "https://agentweb.pro",
      /^https:\/\/[a-zA-Z0-9\-]+\.hireemma\.ai$/,
      "https://hireemma.ai",
      "https://agentweb-user-files.s3.us-west-2.amazonaws.com", // S3 bucket for user files
```

String match is exact (`L252–256`).
`credentials: true` (`L293`) — a hit is a
credentialed origin (Authorization + cookies), not
an `<img src>` rewrite.

| Face | Matcher | What it sees |
|---|---|---|
| Email rewrite (cycle 187) | `includes(S3_BUCKET_HOST)` | full URL, path included |
| CORS L224 | `origin ===` that host | Origin = scheme+host+port, **no path** |
| HTML repair | `includes('agentweb-user-files.s3')` | `agentModeService.ts` L30399 / L30407 / L30415 / L30420 / L30428 |

Repair is **wider** than CORS: region-less
`bucket.s3.amazonaws.com` matches repair, fails
CORS. Path-style `https://s3.amazonaws.com/bucket/…`
(Family A test Location, cycle 188) misses **both**
CORS and repair (bucket is not in the hostname).

`cors.test.ts` L155–170 pins `hireemma.ai` /
`www.hireemma.ai`. Grep of that file for `s3` /
`user-files` is empty. ENG-1751 gated ngrok as a
credentialed origin; the S3 literal is the same
class and untested.

README CloudFront (L1569 / L1579–1581) serves lead
forms as `*.agentwebforms.com` — already allowed by
the L220 regex. L224 is the **raw S3 URL** Origin
when a browser opens an Emma HTML report
(`createHtmlFile` `s3_url`) instead of a form CNAME.

Hermes persist does not mint a credentialed CORS
origin per URL spelling. Copying
`deriveOwnBucketKey` onto CORS would be wrong
(Origin has no path). A host-set (regional +
region-less virtual-hosted of our bucket) is the
in-process port, after #2, not instead of Q-014.

## What this is not

Not a product patch. Do not change CORS on a
research turn. Do not add A-021.

Not a Q-014 / Q-001 / Q-003 status change. MCP
`generate_image` persist is Family A; the Origin
that HTML reports send is independent of listing.

Not A-006. HTTP-splitting HTML reports would still
need this Origin on whichever process serves
`/api`.

## Relation to A-002 / A-007 / A-008

A-008 persist should emit one public URL shape so
CORS can list one origin. Until then, L224 is the
Family B host only. Do not HTTP-split.

## Next cycle candidate

HTML repair `includes('agentweb-user-files.s3')`
is a third matcher, wider than CORS, narrower than
`extractS3KeyFromUrl`. Five call sites in one
method. File-level. Do not add A-021.
