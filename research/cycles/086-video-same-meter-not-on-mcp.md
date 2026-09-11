# Cycle 86 — generate_video is the same meter, not on MCP, not a nanoservice

**UTC:** 2026-09-11T22:02:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.
**Do not un-park:** Q-016.

## Question

Cycle 85: default image is $0.134 in an in-process book. Is
video a reason to HTTP-split (or to delay Q-014) — a second
deploy unit — or the same leaf pattern, not even listed on MCP?

## Finding

**Video is the same fire-and-forget `$` / 0-token meter on an
already-metered `emmaApi` route. MCP `src/mcp/` has zero
`generate_video` registers. Q-016 is “list like Q-014,” 10–40×
more expensive. A fifth process would copy the same holes
(cycles 81–85) onto a costlier leaf.**

### Same meter shape as images

`videoGeneration.ts` L1093–1106 (after success):

```
void meterUserUsage({
  ...
  inputTokens: 0,
  outputTokens: 0,
  costUsdOverride: videoGenerationCostUsd(modelToUse, requestedDuration),
});
```

Same `void`, same 0 tokens, same `costUsdOverride` as
`imageGeneration.ts` L551–563. Cycles 81–82 apply unchanged:
check-then-act GET, default token gate does not see `$`.
`checkExtraCostUsage` still unused (cycle 84).

`videoGenerationCostUsd` (`llmPricing.ts` L373) reads
`VIDEO_GENERATION_PRICING_USD_PER_CLIP` L313–322:

| Model | USD / 8s clip |
|---|---|
| `veo-3.1-generate-preview` / `veo-3-generate-preview` | 3.20 |
| `veo-3.1-fast-generate-preview` | 1.40 |
| `seedance-2.0` (Emma default, `emma/tools.ts` L5097) | **1.55** |

$1.55 / $0.04 (`gpt-image-2`) ≈ **39×**. $1.55 / $0.134
(default image) ≈ **12×**. ENG-973 cost concern that parked
Q-016 is this book, not a missing Kubernetes slice.

### The hop already exists; MCP does not list it

`emmaTokenBudget.ts` L59: `'POST /generate-video': 'metered'`.
`emmaApi.ts` L189–193 already calls `svc.generateVideo`.
`backend/src/mcp/` grep: **empty**. Emma in-app:
`emma/tools.ts` L5080. Q-016’s first slice is mcpFetch-list
onto that route (same as Q-014), not a new process.

Hermes/OMP: one catalog. AgentWeb video is on the **Emma**
catalog only. Listing it later (Q-016) is composition via
MCP; extracting `videoGeneration.ts` to HTTP would split
Remotion compose (cycle 55) from the meter the way A-006
would split C2PA/logo from images.

## Queue effect

A-006 stays **discard** (new citation: video is the same meter
on a costlier leaf; MCP does not list it). Q-016 stays **park**.
Q-014 stays **ready** — do not wait for video. Q-003 stays
ready (image default, not video).

## Next

Cycle 87: cheapest remaining mapping. Candidate: collision
refresh on AgentWebPro for `apiTools.ts` / `loops/core` /
`llmPricing.ts` before Q-014 wrap. Do not un-ready Q-001 /
Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
