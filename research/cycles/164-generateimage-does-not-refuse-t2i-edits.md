# Cycle 164 — AgentWeb does not refuse `input_images` on t2i-described models

**Date:** 2026-09-12T00:52:00Z
**Question:** Cycle 163: Hermes hides `image_url` **and** rejects it at
`_prepare_fal_request` L367–370 if the model has no `edit_endpoint`.
Does AgentWeb `generateImage` refuse `input_images` when the chosen
model is described as text-to-image only?

**Answer:** No. Emma’s catalog **text** says `gemini-2.5-flash-image` is
t2i-only (`emma/tools.ts` L5035). The leaf still takes the edit branch.
`validateParams` never checks capability. Hermes would have saved the
turn **and** the vendor call. AgentWeb pays both. Not a nanoservice.

## Evidence

Emma schema L5035 (in the `imageModel` description, not a gate):

> gemini-2.5-flash-image (Google, text-to-image only, no logo compositing)

MCP `apiTools.ts` L2088 always lists `input_images` with no model note.
`image_model` is a free string (L2090), not Emma’s enum (L5036). After
Q-014, Hermes-as-client can pass `gemini-2.5-flash-image` +
`input_images`.

Policy `generateImage` (`agentModeService.ts` L28857): HITL on any
non-empty `inputImages` (L28893) regardless of model. Then L28991
`imageService.generateImage(primaryRequest)` with those images.

Leaf `imageGeneration.ts`:

- `validateParams` L1514–1533 checks **quality** and **filename** only.
  No `SUPPORTED_MODELS` × `inputImages` matrix.
- `generateWithGoogleGemini` (hardcoded `gemini-2.5-flash-image`,
  L847) branches: `inputImageCount === 0` t2i (L859); `=== 1` edit
  (L924); else multi-image (L1015). The t2i-described model is the
  one with the explicit edit path.
- Fallback `getImageGenerationFallbackModel` L3299–3301 **refuses**
  failover when `inputImages` or `logoImage` exist. Explicit
  `gemini-2.5-flash-image` + edits still hits the leaf (L3295 also
  refuses fallback when the LLM named the model).

Hermes live contrast: `test_t2i_only_model_hides_edit_args` **and**
`test_handler_still_rejects_unadvertised_edit_with_teaching_error`
(`"capable of image-to-image / editing"` / `"omit image_url"`). Two
layers. AgentWeb has a comment in a sibling catalog and a vendor POST.

## What this is not

Not a product patch. Do not add a capability matrix on this turn.
Do not un-ready Q-003 (fail-open arena mapper, not this refuse).
Q-014 still lists the static MCP face. Optional later, in A-007’s
file: omit `input_images` when the resolved default is t2i-only,
**and** a leaf refuse that matches Emma’s sentence. Do not add A-021.

Not A-006. The lie is three in-process faces disagreeing. HTTP-splitting
`generateImage` would copy the lie onto a fifth hop.

Not a Q-014 / Q-001 / Q-003 status change.

## Relation to A-002 / A-007 / A-008

A-008’s `git mv` of `imageGeneration.ts` is where a capability refuse
would live (next to C2PA / CRITICAL LOGO). A-007 is where tools/list
would stop advertising the arg. After #2, not instead of Q-014.

## Next cycle candidate

`logoImage` is `params.inputImages.push` **before** model routing
(`imageGeneration.ts` L477–485, then `hasInputImages` L488). Does a
`logo_image` on `gemini-2.5-flash-image` therefore become an edit the
Emma sentence says that model cannot do? File-level. Do not add A-021.
