# Cycle 180 — onboarding pins Gemini 3; Q-003’s unspecified path never runs

**Date:** 2026-09-12T01:29:00Z
**Question:** Cycle 179 next: `onboardingAdImageService.ts`
L84 `DEFAULT_IMAGE_MODEL` is `gemini-3-pro-image-preview`.
Is that the leaf’s unspecified default (cycle 170 L492),
or a third copy that skips Q-003?

**Answer:** A **duplicate explicit id**. `generateWithTimeout`
L493 always passes `imageModel: DEFAULT_IMAGE_MODEL`, so
leaf L492 never fires. Q-003 brief item 4 already skips
when the caller set `imageModel` **or** `logoImage` —
onboarding often passes both. L83 “supports 1080x1080 +
1080x1350” is Gemini **aspect-ratio** mapping, not 1080px
output. Azure t2i L712 would send those strings as `size`
unconverted. Do not un-ready Q-003. Not a nanoservice.

## Evidence

```83:84:backend/src/services/onboardingAdImageService.ts
/** Default Gemini Pro image model — supports 1080x1080 + 1080x1350. */
const DEFAULT_IMAGE_MODEL = "gemini-3-pro-image-preview";
```

```488:494:backend/src/services/onboardingAdImageService.ts
      gen.generateImage({
        prompt, filename, userId,
        size: format,          // "1080x1080" | "1080x1350"
        imageModel: DEFAULT_IMAGE_MODEL,
        ...(logoUrl ? { logoImage: logoUrl } : {}),
      }),
```

| Unspecified / default | Id | Q-003 mapper? |
|---|---|---|
| Leaf L492 if `!params.imageModel` | Gemini 3 | yes (item 4: no explicit model) |
| Blog heroes (cycle 177) | omit → L492 | yes |
| Onboarding L84 / L493 | **explicit** Gemini 3 | **no** |
| Onboarding + `logoImage` | same | **no** (item 4 logo skip) |
| Browser task (cycle 178) | `openai-image-1` | out of scope (item 7) |

Gemini 3 `convertSizeToAspectRatio` L1123–1172 maps
1080/1080 → `1:1`, 1080/1350=0.8 → `4:5`. `imageSize` is
quality (default medium → **2K**, L1204–1209). Timeout
wrapper does not pass `quality`. Pixel 1080 lives in the
**prompt** (L304–305), not the vendor output size.

Azure t2i `generateWithAzureAI` L712 `size: params.size`
has no converter. A Q-003 flip of L492 to `gpt-image-2`
would not change onboarding; copying the flip here would
send `1080x1350` to Azure as a size enum.

Three hardcoded defaults, no shared constant:
leaf L492 / `isAvailable` L1542, onboarding L84,
agent-engine `openai-image-1`. Hermes `FAL_MODELS` is
one row. Not A-006.

## What this is not

Not a product patch. Do not edit onboarding on a research
turn. Do not add A-021.

Not a Q-014 / Q-001 / Q-003 status change. The brief already
scopes the mapper off explicit model and logo. This cycle
is why onboarding ads stay Gemini 3 after a Matt-gated
leaf flip. First slice stays the unspecified Emma path.

Not A-006. HTTP-splitting the leaf would leave L84 as a
second client default.

## Relation to A-002 / A-007 / A-008

A-008 capability table should own size conversion per
vendor (Gemini ratio vs Azure enum). Onboarding’s format
type is Instagram pixels; the leaf speaks two dialects.
After #2, not instead of Q-014.

## Next cycle candidate

`generateWithTimeout` `Promise.race` L487–507 does not
abort the leaf at 180s. A timed-out variant still meters
(cycle 174: meter before persist). File-level. Do not
add A-021.
