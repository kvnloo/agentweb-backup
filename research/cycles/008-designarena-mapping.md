# Cycle 008 — DesignArena ↔ AgentWeb image IDs

**When:** 2026-09-11T17:28Z  
**Focus:** Live DesignArena leaderboard vs `SUPPORTED_MODELS`. Do not reshuffle
Q-001 / Q-014 READY. Optional refine until `stop_after`.

## Citations

- `kvnloo/mcp-bench-router` `src/services/model-mapper.ts` `STATIC_MAP` — **zero
  image models**. That MCP routes *code/design* (HTML/UI) through OpenRouter
  chat IDs. It cannot pick Emma's Azure/Gemini/Runway providers.
- DesignArena POST `https://www.designarena.ai/api/leaderboard`
  `{arenaType:"models", category}` — categories `image`, `logo`,
  `graphicdesign`, `imagetoimage` do overlap AgentWeb IDs by **exact
  `modelId` string**.
- `backend/src/services/imageGeneration.ts` L16–28 `SUPPORTED_MODELS`;
  L1542 hardcoded default `gemini-3-pro-image-preview`.
- `agentModeService.ts` L2206 `IMAGE_API_MODELS` (no `gen4_image`);
  L28986 / L1542 same hardcoded default; L3307 failover already
  `['gpt-image-2', 'gemini-3.1-flash-image', 'gemini-2.5-flash-image']`.
- `llmPricing.ts` `IMAGE_GENERATION_PRICING_USD`: `gpt-image-2` **$0.04**,
  `gemini-3-pro-image-preview` **$0.134**.
- `backend/src/routes/image-models.ts` L11 stale fallback `'openai-image-1'`
  (not in `SUPPORTED_MODELS`). Partner-portal display only; not the Emma
  default. Not a Kevin wedge — leave it.
- ENG-381: only comments in this tree (`localAgentTools.ts`). Not a public
  GitHub issue. Kevin's Linear (`0ism`) has no AgentWeb ENG board. **Ownership
  still unconfirmable.** Q-011 stays parked. Do not file AgentWeb tickets in
  zer0.

## Snapshot (2026-09-11T17:28Z)

Among models AgentWeb already serves, DesignArena `image` rank:

| Arena / AgentWeb id | Image rank | Elo | Price |
|---|---|---|---|
| `gpt-image-2` | **#3** | 1366 | $0.04 |
| `gemini-3.1-flash-image-preview` → GA `gemini-3.1-flash-image` | #14 | 1271 | $0.039 |
| `gemini-3-pro-image-preview` (**current default**) | **#22** | 1219 | $0.134 |
| `gpt-image-1` | #33 | 1194 | $0.04 |
| `gemini-2.5-flash-image` | #39 | 1181 | $0.039 |

`logo` category: `gpt-image-2` is **#1**. Current default is **#40**.

Not in AgentWeb (do not add in the first slice): `riverflow-2.5-pro` (#1
image), `gpt-image-2.5-sunburst` / `flare`, Grok Imagine, Seedream, Imagen.

`gen4_image` / Runway: no DesignArena hit in this snapshot.

## Queue effect

- **Q-003** KEEP → **ready**. Brief: `briefs/Q-003-designarena-adapter.md`.
  Evidence 4→5. Score 31→38. **Implementation order still Q-001, Q-014,
  then Q-003** — flipping the customer default has blast radius (Matt);
  Hermes OAuth and MCP listing do not.
- Q-001, Q-014 unchanged READY.
- Q-011 still park (ENG-381 ownership).
- Collision refresh: still avoid #2862, #2271, #2861, #2563, #2871, #2875.
  No open PR on image-model routing.

## Mapping artifact

`research/mappings/designarena-image-models.md`
