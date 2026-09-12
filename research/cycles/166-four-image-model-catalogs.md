# Cycle 166 — Four image-model catalogs, one leaf; Hermes has one

**Date:** 2026-09-12T00:58:00Z
**Question:** Cycle 165: MCP `image_model` is an untyped string
(`apiTools.ts` L2090); Emma has an enum (L5036); the leaf
`SUPPORTED_MODELS` (L16–28) includes a preview alias Emma does not.
How many catalogs does one `generateImage` call consult, and does
`IMAGE_API_MODELS` actually match the leaf as its comment claims?

**Answer:** Four in-repo lists plus pricing. `IMAGE_API_MODELS`
L2203 says it “must match `SUPPORTED_MODELS`” — it does **not**.
Runway is on Emma + leaf, not on the admin default. The preview
alias is on admin + leaf, not on Emma. MCP has no list at all.
Hermes’ `FAL_MODELS` is the one catalog the schema builder, handler,
and `test_every_model_declares_capability_keys` all read. Not a
nanoservice.

## Evidence

| Catalog | Where | Ids |
|---|---|---|
| MCP tools/list | `apiTools.ts` L2090 | free `string`; no enum |
| Emma tool | `emma/tools.ts` L5036 | 7: Gemini 3 / 3.1 / 2.5, gpt-image-1/2, **Runway** `gen4_image` + `gemini_2.5_flash`. **No** preview alias |
| Leaf | `imageGeneration.ts` `SUPPORTED_MODELS` L16–28 | 8: Emma’s 7 **plus** `gemini-3.1-flash-image-preview` |
| Admin default | `agentModeService.ts` `IMAGE_API_MODELS` L2206; partner-portal `AdminDashboard.tsx` L8563 | 6: Gemini 3 / 3.1 / preview / 2.5, gpt-image-1/2. **No Runway** |
| Meter | `llmPricing.ts` `IMAGE_GENERATION_PRICING_USD` L297–307 | leaf’s 8 (preview kept for historical rows) |

Comment L2203: “must match SUPPORTED_MODELS in imageGeneration.ts.”
False. Partner-portal L8560 “Keep in sync with …
IMAGE_API_MODELS” is a **second** copy of the shorter list
(`AdminDashboard.imageModels.test.ts` L27–34 pins that copy, not
the leaf).

`getImageApiDefaultModel` L2213: a Dynamo default of `gen4_image`
is “unsupported” and returns `undefined`; the leaf then hardcodes
`gemini-3-pro-image-preview` (L493–494). Emma can still pass Runway
per-call. Q-003’s mapper target is the **leaf** list; do not un-ready
it.

Hermes live: `FAL_MODELS` from `image_generation_catalog.py`;
`test_every_model_declares_capability_keys` fails CI when a new
model is added without the keys the schema builder reads. One
catalog, two layers (cycle 163–164). AgentWeb: four catalogs, no
capability matrix, comment already stale.

## What this is not

Not a product patch. Do not unify the four lists on this turn.
Do not add A-021. A-011 parks **field** unify (Emma camelCase vs
MCP snake). This is **id membership**. Same park reason: Q-014
lists the MCP face as-is.

Not A-006. Copying any one list into a fifth process would freeze
the drift.

Not a Q-014 / Q-001 / Q-003 status change. Q-003 maps onto
`SUPPORTED_MODELS`, the only list the vendor switch actually uses.

## Relation to A-002 / A-007 / A-008

A-008’s moved `imageGeneration.ts` should own the membership list.
A-007’s schema can `$ref` that list instead of a free string.
Admin dropdown stays a **subset** (no Runway default) if product
wants that — document it, do not comment-lie “must match.” After
#2, not instead of Q-014.

## Next cycle candidate

Does MCP `input_images` + garbage `image_model` hit HITL
(`generateImage` L28893) **before** the leaf’s `Invalid imageModel`
(L502–506)? File-level order. Do not add A-021.
