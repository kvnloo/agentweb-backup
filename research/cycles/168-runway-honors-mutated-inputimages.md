# Cycle 168 — Runway honors mutated `inputImages` as `referenceImages`

**Date:** 2026-09-12T01:02:00Z
**Question:** Cycle 167: Emma enum includes Runway; `IMAGE_API_MODELS`
does not. Does `generateWithRunwayML` drop `inputImages` / the
cycle-165 logo mutation, or send them?

**Answer:** It sends them. L1363–1390 builds `referenceImages` from
`params.inputImages` after the L477–485 push. Admin omitting Runway
from the default dropdown is **not** a capability gate. Emma can
still name `gen4_image` per-call; MCP can too (free string). The
leaf will POST the logo as a Runway reference. Not a nanoservice.

## Evidence

`generateWithRunwayML` (`imageGeneration.ts` L1340):

- L1347 `inputImageCount = params.inputImages.length` — sees the
  mutated array, not the caller’s original.
- L1363 `if (inputImageCount > 0)` → `requestOptions.referenceImages`
  (`uri` data URLs).
- L1394 `client.textToImage.create(requestOptions)` — still the
  **textToImage** endpoint, with references, not a separate edits
  API. Contrast Azure L669 `/images/edits` when `hasInputImages`.

So: Gemini 2.5 Flash (cycle 164) has an explicit edit branch Emma
called t2i-only. Runway always `textToImage`, optionally with
references, and Emma **does** list it. The catalog lie is inverted:
admin hides Runway as a default; the leaf still composites.

Fallback L3299 treats logo as `editsExistingImage` and refuses
failover, so a Runway+logo timeout is not recovered by `gpt-image-2`.

Hermes: `FAL_MODELS[model].edit_endpoint` decides whether sources
are allowed (L364–370). One key. AgentWeb: three vendor shapes
(Azure edits URL, Gemini parts, Runway `referenceImages`) after
one unconditional mutate.

## What this is not

Not a product patch. Do not remove Runway from Emma. Do not add
Runway to `IMAGE_API_MODELS` from this cycle (product default is
Matt / Q-003). Do not add A-021.

Not a Q-014 / Q-001 / Q-003 status change. Q-003 maps arena ranks
onto the leaf list that already includes Runway.

Not A-006. The three vendor shapes are why the adapter stays in this
process (A-008).

## Relation to A-002 / A-007 / A-008

A-008 owns the mutate + three vendor branches. A capability table
(`model → {edit, logo, refs}`) next to `SUPPORTED_MODELS` is the
Hermes `FAL_MODELS` analog. After #2.

## Next cycle candidate

Does `generateWithAzureAI` `/images/edits` (L649–669) use only
`inputImages[0]` (L651) and drop extras + the logo if both are
present? File-level. Do not add A-021.
