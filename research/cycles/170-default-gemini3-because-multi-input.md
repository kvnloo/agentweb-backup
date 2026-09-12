# Cycle 170 — L492 already documents why the default is not `gpt-image-2`

**Date:** 2026-09-12T00:58:00Z
**Question:** Cycle 169: Azure `/images/edits` keeps `inputImages[0]`.
Did the leaf already record that as the reason the hardcoded default
is Gemini 3, and would Q-003’s cheaper default flip land unspecified
calls on that drop?

**Answer:** Yes. L492–494 sets `gemini-3-pro-image-preview` when
unset, with the comment “supports multiple input images.” Q-003’s
**first slice** is still a fail-open DesignArena → `SUPPORTED_MODELS`
mapper. The **prod default flip** to `gpt-image-2` is already in
QUEUE.md’s do-not (“Flip prod default without Matt”). Cycle 169 is
why that do-not is not just taste/$0.04: unspecified + logo + edit
would silently drop logo bytes. Do not un-ready Q-003.

## Evidence

```491:494:backend/src/services/imageGeneration.ts
      // If model not defined, use gemini-3-pro-image-preview as default (supports multiple input images)
      if (!params.imageModel) {
        params.imageModel = "gemini-3-pro-image-preview";
      }
```

`getImageApiDefaultModel` (`agentModeService.ts` L2221–2222)
returns `undefined` when unset so **this** comment is the live
unspecified path. `IMAGE_API_MODELS` includes `gpt-image-2` (admin
**can** pick it). Emma enum includes it. MCP free string can name
it. Fallback order L3307 is `gpt-image-2` first — but only for
t2i-without-logo (cycle 164 L3299). Edits never fail over onto
Azure. The **default** is the remaining door.

Q-003 README do-not: “Flip prod default without Matt.” Arena: live
`gpt-image-2` image #3 / $0.04 vs default #22 / $0.134. Cycle 170
adds: #3 is also `max_refs=1` in this leaf. Matt’s taste call must
include that, not only rank and price. Mapper onto `SUPPORTED_MODELS`
does not have to change the default.

Hermes: model is out-of-band `hermes tools`; `FAL_MODELS` carries
`edit_endpoint` + `max_reference_images` next to the id. One catalog.
AgentWeb’s cheaper-id is in `llmPricing.ts`; the capability comment
is on the default assignment, not on the id.

## What this is not

Not a product patch. Do not change the hardcoded default on this
turn. Do not un-ready Q-003. Do not add A-021.

Not a Q-014 / Q-001 status change. Q-014 lists `image_model`;
clients who omit it still hit Gemini 3 today.

Not A-006. The default is an in-process assignment.

## Relation to A-002 / A-007 / A-008

A-008 should keep L492’s Gemini 3 default until Matt says otherwise.
A capability table would make “why not gpt-image-2 by default”
a column, not a comment. After #2.

## Next cycle candidate

Azure edit `axios.get` L654 skips `processInputImage` (L816: 30s
timeout, User-Agent, SVG→PNG). Gemini/Runway use the helper (Runway
also short-circuits `data:image/`). File-level. Do not add A-021.
