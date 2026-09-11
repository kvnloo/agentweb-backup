# Human-eval `outputSummary` parser (Q-002)

Not a live router. Q-003 is. This is the contract if someone later wants
an offline Matt-queue report. No Dynamo attribute. No per-request scan.

## Where the model string lives

Enqueue (`agentModeService.ts` ~L29108):

```
Image generated: ${filename}. Model: ${imageModelUsed}. Size: ${size}. Quality: ${quality}.
```

`imageModelUsed` is the model that **succeeded** (including failover).

## Pure function

```
parseEvalImageModel(summary: string): string | undefined
```

- Input: `candidate.outputSummary`
- Match: `/Model:\s+([A-Za-z0-9._-]+)/`
- Then `normalizeImageModel(id)` (preview → GA alias)
- Accept only if the result is in `SUPPORTED_MODELS` / `IMAGE_API_MODELS`
- Else `undefined` (skip)

Do not NLP Slack `feedback[].text`. A reply marks `status: reviewed`
with no like/reject. Treating “any reply” as a win or loss is false.

## Allowed use

- Offline: `listCandidates({ reviewType: 'creative_image', status: 'reviewed' })`
  once, parse, count rows per model. Admin report or a comment in Q-003
  review. Cap the scan the same as `listCandidates` (20 pages).
- Never call this from `generateImage` / `getImageGenerationFallbackModel`.

## Forbidden

- New GSI or `imageModel` attribute on `AW-HumanEvalQueue` (Harsha).
- Mixing onboarding `imagePromptQualityService` like-rates (prompt
  archetypes) into provider order.
- Changing Matt/Fangfang reviewer assignment.

## Fixture (from the enqueue template)

| summary | parse |
|---|---|
| `Image generated: x.png. Model: gpt-image-2. Size: auto. Quality: medium.` | `gpt-image-2` |
| `Image generated: x.png. Model: gemini-3.1-flash-image-preview. Size: auto. Quality: medium.` | `gemini-3.1-flash-image` (alias) |
| `Landing page generated` | `undefined` |
| `Image generated: x.png.` (no Model) | `undefined` |
