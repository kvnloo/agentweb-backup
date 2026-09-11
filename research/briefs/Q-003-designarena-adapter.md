# Q-003 brief — DesignArena adapter for Emma image default

Status: **ready** (pure map + fail-open fetch; no schema). **Not the first
PR.** Implementation order: Q-001, Q-014, then this. Needs Matt before any
production default flip.

## Problem

Emma's image default is hardcoded `gemini-3-pro-image-preview`
(`imageGeneration.ts` L1542, `agentModeService.ts` L28986). On DesignArena
`image` (2026-09-11 snapshot) that id is **#22 / $0.134**. Already-supported
`gpt-image-2` is **#3 / $0.04** and **#1 on `logo`**.

`mcp-bench-router` cannot be dropped in: its mapper is OpenRouter **chat**
IDs. AgentWeb images are Azure GPT-image / Gemini / Runway.

Human-eval has no `imageModel` field (cycle 4). It cannot be the live
router. DesignArena can.

## Acceptance

1. A pure function `mapArenaToSupported(entries, SUPPORTED_MODELS)` returns
   the highest-Elo exact (or documented-alias) match, or `undefined`.
2. Fixture test frozen from `research/mappings/designarena-image-models.md`
   (2026-09-11 snapshot): `image` → `gpt-image-2`; unknown/empty →
   `undefined`.
3. Fetch `https://www.designarena.ai/api/leaderboard` with
   `{arenaType:"models", category:"image"}`, cache ≤2h, **fail open**.
4. Does not run when the caller passed an explicit `imageModel`, or when
   `inputImages` / `logoImage` is set (brand/edit invariant).
5. Does not add `gpt-image-2.5-*`, Riverflow, Imagen, or a Dynamo table.
6. `meterUserUsage` still fires on the model that actually generated.
7. `image-models.ts` stale `'openai-image-1'` fallback is **out of scope**.

## First slice (this repo)

- `backend/src/services/designArenaImageRouter.ts` (new, small) + tests.
- Wire as optional reorder of `getImageGenerationFallbackModel` **or** behind
  an existing AW-Settings key if one already means "default image model".
- **Do not** change the hardcoded default in production until Matt confirms
  gpt-image-2 taste is acceptable for ads.

## Out of scope

ComfyUI (Q-009), eval-table GSI (Q-002), MCP listing (Q-014), video/Veo.

## Collision

None on open AgentWebPro PRs (2026-09-11). Don't touch `callLLM` (#2862).

## Rollback

Delete the adapter; default remains `gemini-3-pro-image-preview`.
