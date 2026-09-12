# Cycle 173 — S3 upload always claims `image/png`

**Date:** 2026-09-12T01:08:00Z
**Question:** Cycle 172: Azure FormData always PNG. Does the
shared S3 hop (L582–587) also stamp `image/png` even when a
vendor returned JPEG?

**Answer:** Yes, the ContentType is a **literal**, not derived
from the data URL, magic bytes, or `getImageMimeType`. Gemini 3
is the only vendor path that even puts the vendor MIME on the
data URL (`data:${finalMimeType}` L1319–1320). The S3 hop then
`split(',')[1]` and throws the prefix away. Default-on C2PA
re-encodes via `sharp().png()` so the **successful strip path
is actually PNG** — the S3 label is honest only because that hop
rewrote the bytes. `removeC2PA: false` (tested) or a strip
failure (returns original buffer) can upload Gemini 3 JPEG/
WebP labelled PNG. Not a nanoservice.

## Evidence

| Hop | What it knows |
|---|---|
| `ImageGenerationResult` L8–13 | `imageUrl` + `filename`. **No `mimeType`.** |
| Gemini 3 L1305 / L1319–1320 | `inlineData.mimeType \|\| 'image/png'` into the data URL |
| Gemini 2.5 L916 / L1101 | Hardcodes `data:image/png` (never reads output MIME) |
| Azure t2i L715 / L740 | Requests `output_format: "png"` then labels PNG — honest |
| Azure edits L697 | Labels PNG regardless of source (cycle 172) |
| OpenAI L1495 | `data:image/png` from `b64_json` |
| Shared persist L566–587 | `startsWith('data:image/')` → `split(',')[1]` → `uploadFileToS3(..., 'image/png')` |
| `getImageMimeType` L752–785 | Exists; used for **inputs** only (`processInputImage`) |
| C2PA L110–124 | Comment: “We convert to PNG”. `sharp(imageBuffer).png(...)` |
| C2PA fail-open L128–131 | Returns original buffer on sharp error |

`removeC2PA !== false` defaults true (L576). Tests accept
`removeC2PA: false` (`imageGeneration.test.ts` L1185–1215).
Gemini 3 last-part tests (L468–475) **use** `removeC2PA: false`
and capture the buffer; they never assert the 4th S3 arg.
`removeImageBackground` tests do pin `'image/png'` — a different
leaf that really emits PNG.

Runway L1400 returns `taskAny.output[0]` as a URL. L570–572
then **skips** S3 (and therefore C2PA). That is the next-cycle
candidate, not this one.

Hermes FAL keeps vendor URLs. There is no S3 re-label in
`image_generation_tool.py`. AgentWeb persists because C2PA +
meter + user files live in this process. Copying that to HTTP
would need a `mimeType` on the result; the type has none.

## What this is not

Not a product patch. Do not add MIME to MCP `generate_image`.
Do not add A-021.

Not a Q-014 / Q-001 / Q-003 status change. Listing the tool
does not create a ContentType contract.

Not A-006. The MIME seam is in-process: vendor → data URL →
C2PA → S3. HTTP-splitting any hop would guess again.

## Relation to A-002 / A-007 / A-008

A-008 is the place a `persistGeneratedImage(buffer, mime)`
would parse the data-URL prefix (or take Gemini 3’s
`finalMimeType`) and pass it to `uploadFileToS3`. After #2,
not instead of Q-014. C2PA default-on stays in that leaf.

## Next cycle candidate

Runway L1400 is a URL, so L570–572 skip S3 and C2PA. Does
“C2PA default-on” apply to all vendors, or only data-URL
ones? File-level. Do not add A-021.
