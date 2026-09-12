# Cycle 174 — Runway HTTPS skips C2PA and S3

**Date:** 2026-09-12T01:10:00Z
**Question:** Cycle 173: S3+C2PA run only after a `data:image/`
payload. Runway L1400 returns `taskAny.output[0]`. Does
“C2PA default-on” apply to all vendors?

**Answer:** No. It is a **data-URL** invariant, not a vendor
invariant. Meter runs for every success (L545–563), then
L566–572 returns immediately when the URL does not start
with `data:image/`. Runway `gen4_image` and `gemini_2.5_flash`
are 2 of 8 `SUPPORTED_MODELS` and tests pin
`output: ['https://runway.com/image.png']`. Those generations
are billed, keep C2PA, and never land in user S3. The
download+strip path already exists as a **second** tool
(`removeC2PAFromImage` L29537–29545) and REST
`POST /remove-c2pa`. MCP has zero `remove_c2pa` registers.
Not a nanoservice.

## Evidence

| Path | Persist / C2PA |
|---|---|
| Azure / Gemini 2.5 / Gemini 3 | `data:image/...` → C2PA (default on) → S3 |
| Runway L1394–1411 | `textToImage.create().waitForTaskOutput()`; `output[0]` is HTTPS |
| Shared hop L566–572 | else: “It's already a URL, we can't upload it” `return result` |
| Meter L551–563 | **Before** the data-URL check — Runway is charged |
| Tests | `imageGeneration.test.ts` L214 / L581 / L611 / L641 |
| Emma strip | `emma/tools.ts` L4925 `remove_c2pa_from_image` downloads HTTP |
| REST strip | `emmaApi.ts` L216–219 |
| MCP | grep `remove_c2pa` in `mcp/` is empty |

Cycle 36 cited L575–578 as the leaf C2PA invariant. Those
lines are **after** the data-URL gate. Cycle 166: admin
`IMAGE_API_MODELS` omits Runway; Emma enum includes it; MCP
`image_model` is a free string. After Q-014, Hermes can name
`gen4_image` and receive a vendor CDN URL. Listing
`generate_image` does not list the strip.

`generateWithOpenAI` L1486–1492 also returns a URL (DALL-E
comment). After `includes(SUPPORTED_MODELS)` every live id
hits Azure / Gemini / Runway; that else is unreachable.
File-level next, not this cycle.

Hermes FAL keeps vendor URLs and does not claim C2PA
default-on. AgentWeb’s PROTOCOL invariant is the product
claim this hop does not keep for Runway.

## What this is not

Not a product patch. Do not download Runway in Q-014.
Do not add A-021 to list `remove_c2pa_from_image` on MCP.

Not a Q-014 / Q-001 / Q-003 status change. Q-014 lists the
tool; C2PA remains the leaf’s job, and this cycle names
which vendors the leaf actually strips.

Not A-006. Meter + skip live in one method. HTTP-splitting
would copy the URL-shape gate.

## Relation to A-002 / A-007 / A-008

A-008 `persistGeneratedImage` should accept data URL **or**
HTTPS (the strip tool already downloads). After #2, not
instead of Q-014.

## Next cycle candidate

`generateWithOpenAI` else (L534) is unreachable for every
`SUPPORTED_MODELS` id after normalize. Dead persist sibling
of this URL skip. File-level. Do not add A-021.
