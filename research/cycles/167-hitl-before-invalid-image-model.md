# Cycle 167 — HITL runs before leaf `Invalid imageModel`

**Date:** 2026-09-12T01:00:00Z
**Question:** Cycle 166: MCP `image_model` is a free string. If Hermes
(after Q-014) sends `input_images` + an unknown `image_model`, does
the user confirm the edit **before** the leaf refuses the id?

**Answer:** Yes. Policy order is category → HITL → vendor. The leaf
refuse at `SUPPORTED_MODELS.includes` (L502–506) is **after**
`awaitingUserConfirmation`. Hermes would have dropped the unknown
arg at tools/list (static schema has no `image_model`; model is
out-of-band `hermes tools`) and never asked the human. AgentWeb
pays a confirm turn for a catalog miss. Not a nanoservice.

## Evidence

`generateImage` (`agentModeService.ts`):

1. L28876 — `category` must be `ad` | `organic_post` (visible fail).
2. L28893 — if `inputImages.length > 0` and `confirm !== true`,
   return `awaitingUserConfirmation` with thumbnails. **No**
   `imageModel` check. `confirm` “never reaches the image service”
   (L28892).
3. L28968–28991 — resolve default, then `imageService.generateImage`.

Leaf `imageGeneration.ts` L493–506: default if unset, normalize
preview alias, **then** `if (!SUPPORTED_MODELS.includes(...))`
return `Invalid imageModel '${params.imageModel}'`.

MCP execute L2097–2104 forwards `image_model` as-is (no enum).
Emma enum L5036 would have blocked most garbage **in the LLM
schema**, not after HITL. MCP has no such schema. After Q-014
the thinner face is the one that can waste the confirm.

Fallback L3295: explicit (even invalid) `imageModel` also disables
failover — so a typo is not recovered by `gpt-image-2`.

Hermes: model is not a CallTool arg. Unknown model is a
`hermes tools` selection error, not a human confirm.

## What this is not

Not a product patch. Do not move HITL under the leaf refuse on
this turn (wrong-set confirm is ENG-satisfaction; keep it).
Optional later: validate `imageModel` **before** HITL, same file,
same process. Do not add A-021.

Not a Q-014 / Q-001 / Q-003 status change. Q-014 lists the face
that can hit this order.

Not A-006. The order bug is in one method.

## Relation to A-002 / A-007 / A-008

A-007 can add MCP `image_model` enum from the leaf list so
tools/list cannot name garbage. That still would not hide
`input_images` on t2i-only (cycle 163–164). Both belong in
`infrastructure.ts` after #2.

## Next cycle candidate

Emma enum includes Runway; `IMAGE_API_MODELS` does not. Does
`generateWithRunwayML` honor `inputImages` / `logoImage` the
same way Gemini 2.5 Flash does (cycle 164–165), or drop them?
File-level `imageGeneration.ts` `generateWithRunwayML`. Do not
add A-021. Do not un-ready Q-003.
