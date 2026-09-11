# DesignArena → AgentWeb image model map

Snapshot: **2026-09-11T17:28Z** via POST
`https://www.designarena.ai/api/leaderboard`
`{"arenaType":"models","category":"<cat>"}`.
Cycle 16 re-fetch **2026-09-11T18:30:15Z** (image) / **18:30:16Z** (logo):
AgentWeb intersection ranks and elo **unchanged**.

Refresh ~2h on DesignArena. Do not treat this file as a live feed.

## What mcp-bench-router actually maps

`kvnloo/mcp-bench-router` `STATIC_MAP` is Claude/GPT/Gemini **chat** IDs →
OpenRouter. Categories like `website` / `uicomponent` are HTML generators.
**Do not call `query_design_model` from Emma `generate_image`.** The adapter
for Q-003 is: fetch the `image` (and maybe `logo` / `graphicdesign`)
leaderboard, then intersect with `SUPPORTED_MODELS`.

## Exact-ID intersection (AgentWeb already serves)

Canonical ids from `imageGeneration.ts` `SUPPORTED_MODELS`. Alias
`gemini-3.1-flash-image-preview` normalizes to `gemini-3.1-flash-image`.
`IMAGE_API_MODELS` omits `gen4_image` / `gemini_2.5_flash` (legacy).

| AgentWeb id | image | logo | graphicdesign | imagetoimage | Meter USD |
|---|---|---|---|---|---|
| `gpt-image-2` | #3 (1366) | **#1** (1366) | #3 (1434) | #4 (1345) | 0.04 |
| `gemini-3.1-flash-image` (via `…-preview` row) | #14 (1271) | #16 (1247) | #18 (1248) | — | 0.039 |
| `gemini-3-pro-image-preview` | #22 (1219) | #40 (1180) | #22 (1225) | #15 (1247) | **0.134** |
| `gpt-image-1` | #33 (1194) | #31 (1202) | #30 (1171) | #32 edit (1108) | 0.04 |
| `gemini-2.5-flash-image` | #39 (1181) | #44 (1169) | #39 (1151) | — | 0.039 |
| `gen4_image` | no row | — | — | — | 0.05 |

Current hardcoded default (`gemini-3-pro-image-preview`) is the **most
expensive** supported model and mid-pack on the arena. Failover already
prefers `gpt-image-2` (`agentModeService.ts` L3307) on retryable T2I
failures when the model was not an explicit user choice.

## Aliases (document, do not invent providers)

| Arena `modelId` | AgentWeb action |
|---|---|
| `gpt-image-2` | exact |
| `gpt-image-1` | exact |
| `gemini-3-pro-image-preview` | exact |
| `gemini-3-pro-image-preview-2k` / `gemini-3-pro-image-gen-2k` | **not** in `SUPPORTED_MODELS` — skip (resolution variant) |
| `gemini-3.1-flash-image-preview` | `normalizeImageModel` → `gemini-3.1-flash-image` |
| `gemini-3.1-flash-image-gen-2k` | skip (resolution variant) |
| `gemini-2.5-flash-image` / `gemini-2.5-flash-image-preview` | exact / skip preview-only if not listed |
| `gpt-image-2.5-sunburst` / `gpt-image-2.5-flare` | skip — new model, needs Azure/OpenAI wiring + price book |
| `riverflow-2.5-pro` | skip — new provider |
| `gen4_image` | no arena row this snapshot |

## Fail-open rule for Q-003

If the fetch fails, cache is stale, or the top arena IDs are all
unmapped: keep `gemini-3-pro-image-preview` (today's default) or the
admin `default_image_model` setting. Never throw out of `generate_image`.

Never reorder when `modelExplicitlyChosen`, `inputImages`, or `logoImage`
is set (same gate as `getImageGenerationFallbackModel`).

## Product gate

A live default flip to `gpt-image-2` is cheaper and higher-ranked, but it
changes every unspecific `generate_image` for paying customers. Matt owns
creative taste. First coding slice is the **pure function + fixture**,
wired behind a setting or used only to reorder failover, not a silent
prod default change.
