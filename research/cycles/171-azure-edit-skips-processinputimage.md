# Cycle 171 — Azure edit `axios.get` skips `processInputImage`

**Date:** 2026-09-12T01:00:00Z
**Question:** Cycle 170 next: does Azure `/images/edits` download
through `processInputImage` (30s timeout, User-Agent, SVG→PNG),
or a bare `axios.get`?

**Answer:** Bare `axios.get` at L654. No timeout, no User-Agent, no
SVG conversion, no MIME sniff, no `data:` short-circuit. Gemini and
Runway use the helper (Runway also short-circuits `data:image/`).
The 8 min `withTimeout` (L538) is the only bound — longer than MCP
mcpFetch’s 5 min default (cycle 77–78). Not a nanoservice.

## Evidence

Azure L654–662:

```
const imageResponse = await axios.get(inputImageUrl, { responseType: 'arraybuffer' });
formData.append('image', imageBuffer, { filename: 'input.png', contentType: 'image/png' });
```

`processInputImage` L816–837: `timeout: 30000`, User-Agent
`AgentWeb/1.0`, `getImageMimeType`, `convertSvgToPng` when
`image/svg+xml`. Callers: Gemini L929 / L1024 / L1240; Runway L1375
after a `data:` check (L1371).

Azure uses `require('axios')` inside the method (L645). The helper
uses the module `import axios`. Tests that mock `axios.default.get`
may miss this path.

**SVG nuance:** ENG-933 (`brandLogo.ts` L309–323 / L390–393)
rasterises or rejects SVG **at persist**. Auto-injected
`getPersistedBrandLogoUrlForUser` is already PNG (or missing).
The Azure skip hits **explicit** `logo_image` / `input_images`
URLs (MCP after Q-014; Emma `inputImages`). Not the persisted
gate.

Hermes `_prepare_fal_request` validates then one payload builder.
AgentWeb: three download shapes for one mutated array (cycle 165).

## What this is not

Not a product patch. Optional later, A-008: Azure calls
`processInputImage` then FormData with the returned mimeType.
Do not add A-021.

Not a Q-014 / Q-001 / Q-003 status change. Align `timeoutMs` after
listing (cycle 78), do not HTTP-split to get a 30s GET.

Not A-006. The helper is why identity stays in this file.

## Relation to A-002 / A-007 / A-008

A-008 owns the three download paths. One helper is the OMP
package move: same function, all vendors. After #2.

## Next cycle candidate

FormData `contentType: 'image/png'` is hardcoded (L662) even when
the source is JPEG/WebP. Gemini/Runway pass `processedImage.mimeType`.
File-level. Do not add A-021.
