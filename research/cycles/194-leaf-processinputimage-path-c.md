# Cycle 194 — Leaf `processInputImage` is Path C; Gemini has no data: skip

**Date:** 2026-09-12T02:23:00Z
**Question:** Cycle 193: Emma C2PA/background axios shape
matches `processInputImage` L816. Is that helper Path B
(presign) for Q-014 `input_images`, or Path C?

**Answer:** Path C. `imageGeneration.ts` L816–823 is the
same 30s Mozilla `axios.get` as Emma strip/background.
**No** `isS3Url` / `presignS3Url` / `getS3ObjectStream`.
**No** `data:image/` short-circuit — only Runway L1371
skips data URLs before calling it. Gemini 2.5 (L929 /
L1024) and Gemini 3 (L1240) call it on every URL,
including after `logoImage` is pushed onto
`inputImages` (L477–482). Default model is Gemini 3
(L492), so Q-014 listing + logo/edit hits this helper.
Tests mock `axios.default.get` for HTTPS
`example.com`; Runway alone pins data-URL skip.
`__tests__` grep `processInputImage` is empty. Not a
nanoservice. Do not add A-021. Do not un-ready Q-014.

## Evidence

The helper:

```816:823:backend/src/services/imageGeneration.ts
  private async processInputImage(imageUrl: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const imageResponse = await axios.get(imageUrl, { 
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AgentWeb/1.0)'
      }
    });
```

SVG→PNG after the GET (L831–835). Cycle 171: Azure
`/images/edits` L654 is a **thinner** Path C (no
timeout, no UA, no SVG) and does **not** call this
helper. This cycle: the helper Azure skipped is still
not Path B.

Callers that do use it:

| Vendor | Line | data: skip? |
|---|---|---|
| Gemini 2.5 single | L929 | no |
| Gemini 2.5 multi | L1024 | no |
| Gemini 3 (default) | L1240 | no |
| Runway | L1375 | **yes** L1371 |

Logo mutation happens first:

```477:485:backend/src/services/imageGeneration.ts
      if (params.logoImage) {
        if (!params.inputImages) {
          params.inputImages = [];
        }
        params.inputImages.push(params.logoImage);
```

Then L492 defaults unset model to Gemini 3, which
loops L1236–1240. Cycle 165: logo-only still takes
the edit path. Q-014 MCP `input_images` / Emma
`logo_image` that are S3 URLs (Family A Location or
Family B) therefore Path-C GET inside the leaf.

ENG-792 already named this GET as the failure mode:

```707:709:backend/src/services/onboardingAdImageService.ts
 * `generate_image` makes `processInputImage`'s axios GET throw on EVERY
 * variant, so all three creatives come back as placeholders
```

`classifyBrandLogoUrl` (`brandLogo.ts` L478–496) is
another Path C probe (15s, same UA) whose comment
says the downstream consumer is this helper. Product
added a preflight because the leaf fetch is HTTP.

Runway test L817–846 pins data URL **without** axios.
Gemini 3 multi-image L854–872 mocks
`axios.default.get` for `https://example.com/…`.
Logo-append test L1284–1293 same mock. Zero
`presignS3Url` in `imageGeneration.ts`.

## What this is not

Not a product patch. Do not change the leaf, C2PA,
or logo on a research turn. Do not add A-021.

Not a Q-014 / Q-001 / Q-003 status change. Listing
`generate_image` is still the right first PR. Private
S3 `input_images` fetch is A-008 persist (copy Path B
or Path A onto this helper), after #2.

Not A-006. HTTP-splitting the leaf would copy Path C
onto a fifth process. `describe_image` already
presigns in-process (L9327).

## Relation to A-002 / A-007 / A-008

A-008 persist should own fetch-own-bucket for the
leaf helper **and** Azure L654. One function, all
vendors. After #2. Do not HTTP-split. Do not revive
A-006.

## Next cycle candidate

`videoGeneration.ts` L236–258 is a **second**
`processInputImage` (30s axios, **no** UA, **no**
SVG, default MIME `image/png`). Q-016 parked. Or
Gemini callers vs data URL (Runway-only skip).
File-level. Do not add A-021.
