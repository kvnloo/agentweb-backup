# Cycle 176 — meter `provider` is a prefix, not the dispatch branch

**Date:** 2026-09-12T01:15:00Z
**Question:** Cycle 175: every live id hits Azure / Gemini /
Runway. Does the meter ternary L554–558 label
`gemini_2.5_flash` (underscore, Runway) as runway and
Google `gemini-2.5-flash-image` as gemini?

**Answer:** Yes for those two ids — **by accident of
underscore vs hyphen**, not because meter shares the
dispatch table. Dispatch and `getApiKey` exact-match
`=== "gemini_2.5_flash"`. Meter asks
`startsWith("gemini-")`. The live lie in the same ternary
is **`gpt-image-1` / `gpt-image-2` → provider `"openai"`**
while L525–526 / ENG-410 send them to Azure. Dollars are
`costUsdOverride: imageGenerationCostUsd(modelToUse)`
(model id). Provider is an attribution label. Video already
uses a catalog predicate (`isHiggsfieldModel`). Not a
nanoservice. Do not patch billing in this cycle.

## Evidence

```ts
provider: modelToUse.startsWith("gpt-image")
  ? "openai"
  : modelToUse.startsWith("gemini-")
  ? "gemini"
  : "runway",
```

| id | Dispatch / secret | Meter `provider` |
|---|---|---|
| `gpt-image-1` / `gpt-image-2` | Azure L525; `Azure/Image` | **openai** |
| `gemini-2.5-flash-image` | Google L527 | gemini |
| `gemini-3-*` | Gemini 3 L529 | gemini |
| `gemini_2.5_flash` | Runway L531; `Runway/Image` | runway (underscore ≠ `gemini-`) |
| `gen4_image` | Runway L531 | runway |

`usageRecorderService.ts` L257–261 namespaces vendor rows
`{provider}:…` so two vendors do not overwrite. Azure
gpt-image rows therefore sit under **openai**. Cap deduct
uses `costUsdOverride` (L504–506), not the provider string.

Tests (`imageGeneration.test.ts` L78–84) pin `model`,
`feature`, `costUsdOverride` — **not** `provider`.

Video sibling (`videoGeneration.ts` L37–38 / L1101):
`isHiggsfieldModel` is `HIGGSFIELD_MODEL_IDS` membership,
the same table dispatch uses. Image has no
`isAzureImageModel`. Cycle 166’s four catalogs made the
underscore id; this cycle is the meter reading it as a
prefix.

Hermes `FAL_MODELS` carries the vendor on the catalog row.
They do not re-infer provider from a hyphen after dispatch.

## What this is not

Not a product patch. Do not change `meterUserUsage`.
Do not add A-021. Do not unify Emma vs MCP field names.

Not a Q-014 / Q-001 / Q-003 status change. Listing the tool
does not create a provider enum. Q-003 mapper should emit
leaf ids (`gemini_2.5_flash` not a hyphenated cousin) —
already Matt-gated for other reasons.

Not A-006. Prefix vs exact-match is in-process. HTTP-split
would copy the ternary.

## Relation to A-002 / A-007 / A-008

A-008 is the place to set `provider` from the **same
switch** as L525–532 (copy video’s predicate shape).
After #2, not instead of Q-014.

## Next cycle candidate

`BLOG_SETUP.md` L34 still documents `OpenAI/Image` for a
secret cycle 175 showed the leaf never fetches on a live
path. File-level ops-doc vs dispatch. Do not add A-021.
