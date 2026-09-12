# Cycle 172 — Azure FormData always claims `image/png`

**Date:** 2026-09-12T01:02:00Z
**Question:** Cycle 171: Azure appends FormData with
`contentType: 'image/png'`. Do Gemini/Runway send the sniffed MIME,
or also lie PNG?

**Answer:** Gemini/Runway send the sniffed type.
`processInputImage` returns `{ buffer, mimeType }` from
`getImageMimeType` (Content-Type, then URL extension, default PNG).
Gemini `inlineData.mimeType` (L948 / L1028 / L1236). Runway
`data:${mimeType};base64,...` (L1378). Azure never calls the helper
and hardcodes PNG + `filename: 'input.png'` (L660–662). JPEG/WebP
edit sources on `gpt-image-1` / `gpt-image-2` are labelled PNG.
Hermes FAL payloads keep the URL; they do not re-label bytes.
Not a nanoservice.

## Evidence

| Vendor | How bytes are typed |
|---|---|
| Azure edits | L660–662 `input.png` / `image/png` always |
| Gemini 2.5 / 3 | `inlineData.mimeType: processedImage.mimeType` |
| Runway | `data:${processedImage.mimeType};base64,...` (or pass-through `data:` URL) |
| Azure t2i | JSON `output_format: "png"` (L715) — generate, not edit |

`getImageMimeType` L752–785 maps `.jpg` / `.webp` / `.svg`. Azure
does not call it. A `.jpg` source is still uploaded as PNG-named
bytes. Whether Azure’s edits API sniffs magic bytes is live-Azure
only; this tree always lies.

Cycle 169 already drops extras. This cycle: the **one** image Azure
keeps can still be mis-typed. Two silent lies on the same vendor
path. Hermes “fail clearly rather than silently dropping sources”
(cycle 169) is the same class: don’t lie to the backend.

Logo-only on Azure (cycle 165 table): persisted PNG is correctly
labelled by accident. Explicit JPEG `logo_image` is not.

## What this is not

Not a product patch. Do not add a MIME enum to MCP. Optional later:
Azure uses `processInputImage` and passes `mimeType` into FormData.
Do not add A-021.

Not a Q-014 / Q-001 / Q-003 status change. Q-014 lists `logo_image`
as a string URL; MIME is the leaf’s job.

Not A-006. The type table is in-process.

## Relation to A-002 / A-007 / A-008

A-008 is the place a single `loadInputImage(url) → {buffer, mime}`
would feed all three vendors. After #2, not instead of Q-014.

## Next cycle candidate

Azure t2i L715 `output_format: "png"` vs Gemini streaming whatever
the model returns. Does C2PA strip + S3 upload assume PNG for Azure
edits of a JPEG source (L566–587 always `'image/png'`)? File-level
on the upload path. Do not add A-021.
