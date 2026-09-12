# Cycle 179 — admin seed omits the worker’s Azure `gpt-image-1` branch

**Date:** 2026-09-12T01:28:00Z
**Question:** Cycle 178: Python has a named Azure branch for
`gpt-image-1` (`web_agent.py` L3281). Does the partner
task-model seed offer that id?

**Answer:** No. Empty Dynamo `supported_image_models`
auto-inits **openai-image-1 + FLUX + gemini-2.5-flash-image**
(`ImageModelsSettings.tsx` L71–89). Grep of that file
for `gpt-image-1` is empty. Operators who click through
an empty catalog never pick the Azure named branch;
they get `openai-image-1` → OpenAI else. CLI help L4216
is the same two-id lie. Not a nanoservice.

## Evidence

```71:89:partner-portal/src/components/admin/ImageModelsSettings.tsx
      const defaultModels = [
        { value: "openai-image-1", ... provider: "OpenAI" },
        { value: "FLUX.1-Kontext-pro", ... provider: "Azure" },
        { value: "gemini-2.5-flash-image", ... provider: "Google" }
      ];
```

`fetchConfig` L129–131: if
`supportedImageModels.length === 0`, it **writes** that
seed via `POST /api/settings`. `image-models.ts` L11
fallback and `imageModelService.ts` L22 / L83 are the
same string. Placeholders L449 / L460 still say
`e.g., openai-image-1`.

| Surface | `gpt-image-1` (Azure named) | `openai-image-1` |
|---|---|---|
| `web_agent.py` L3281 | yes | else → OpenAI L3295 |
| CLI `--image-model` help L4216 | **no** | yes (with FLUX only) |
| ImageModelsSettings seed | **no** | yes (default L97) |
| `IMAGE_API_MODELS` / leaf | yes | **no** |

Cycle 178’s intersection was two live ids. This cycle is
the **seed that hides one of them**. Hermes `FAL_MODELS`
lists every dispatch row; this seed is a third worker
catalog that does not match the if-chain.

Q-003 brief item 7 already parks `image-models.ts` L11.
Do not expand Q-003 to rewrite this seed. Task images
are not Emma’s DesignArena map.

## What this is not

Not a product patch. Do not edit `ImageModelsSettings.tsx`
on a research turn. Do not add A-021.

Not a Q-014 / Q-001 / Q-003 status change. Listing MCP
`generate_image` does not seed Dynamo. Matt-gated
default flip still only reorders the **leaf**.

Not A-006. HTTP-splitting the Node leaf would not change
what an empty settings row writes.

## Relation to A-002 / A-007 / A-008

A-008 is the Node capability table. The partner seed is
the **browser-task** catalog (cycle 135 deploy unit).
Aligning seed ids with `web_agent.py` named branches is
a list edit, not a hop. After #2, not instead of Q-014.

## Next cycle candidate

`onboardingAdImageService.ts` L84
`DEFAULT_IMAGE_MODEL = "gemini-3-pro-image-preview"` —
a third in-process default, the Emma leaf one, not
`openai-image-1`. File-level. Do not add A-021.
