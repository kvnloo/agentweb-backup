# Cycle 165 — `logo_image` is mutated into `inputImages` before model routing

**Date:** 2026-09-12T00:54:00Z
**Question:** Cycle 164: Emma says `gemini-2.5-flash-image` cannot
composite a logo. Does the leaf still turn `logo_image` into an edit
for that model?

**Answer:** Yes. `imageGeneration.ts` L477–485 pushes `logoImage` onto
`params.inputImages` and prepends CRITICAL LOGO to the prompt **before**
`hasInputImages` (L488) and **before** the model switch (L525–535).
A `logo_image` on the t2i-described model is an edit the catalog said
would not happen. Hermes fail-closes before the vendor. AgentWeb
mutates, then POSTs.

## Evidence

```477:535:backend/src/services/imageGeneration.ts
      if (params.logoImage) {
        if (!params.inputImages) {
          params.inputImages = [];
        }
        params.inputImages.push(params.logoImage);
        params.prompt = `${params.prompt}\n\nCRITICAL LOGO INSTRUCTION: ...`;
      }

      const hasInputImages = params.inputImages && params.inputImages.length > 0;
      // ...
      } else if (modelToUse === "gemini-2.5-flash-image") {
          generationPromise = this.generateWithGoogleGemini(params);
```

`hasInputImages` is therefore true for logo-only requests. Azure
takes `/images/edits` (L649). Gemini 2.5 Flash takes the
`inputImageCount === 1` branch (L924). Gemini 3 / Runway also see
the mutated array.

Policy `generateImage` L28920–28947: ENG-326/393 compositing gate
runs **before** the leaf. HITL L28893 keys off caller `inputImages`,
not `logoImage` — a logo-only call skips HITL, then the leaf still
treats it as an edit. Fallback L3299 treats `!!logoImage` as
`editsExistingImage` and refuses failover.

MCP always lists `logo_image` (L2089). After Q-014 the advertised
arg is the mutation, not a capability.

Hermes contrast (cycle 163–164): no logo field; edit args hidden
unless `"image" in modalities`; `_prepare_fal_request` L365
“Fail clearly rather than silently dropping sources.” AgentWeb
does the opposite of silent-drop: it **injects** a source the
catalog denied.

## What this is not

Not a product patch. Do not stop appending logo (C2PA / CRITICAL
LOGO live in this leaf — cycle 36). Do not un-ready Q-014. The
fix, later, is the same two-layer Hermes pattern: advertise
`logo_image` only for models that composite, **and** refuse in the
leaf when they do not. That is A-008’s file + A-007’s schema
builder, after #2.

Not A-011 (Emma vs MCP field names). This is catalog **text** vs
leaf **mutation**. Do not add A-021.

Not A-006. The mutation is why identity stays in this process.

Not a Q-014 / Q-001 / Q-003 status change.

## Relation to A-002 / A-007 / A-008

A-008 moves this exact block. Do not “fix toward Hermes” by
removing CRITICAL LOGO. A-007 can stop listing `logo_image` when
the resolved default is t2i-only. Wait on #2.

## Next cycle candidate

MCP `image_model` is an untyped string (`apiTools.ts` L2090);
Emma has an enum (L5036); the leaf `SUPPORTED_MODELS` (L16–28)
includes Runway ids Emma lists and a `gemini-3.1-flash-image-preview`
alias Emma does **not**. File-level: three model catalogs for one
leaf. Do not add A-021. Do not un-ready Q-003.
