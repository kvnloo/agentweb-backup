# Cycle 025 — MCP generate_image already loopbacks into the monolith

UTC: 2026-09-11T19:04Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **Collision filter** `imageGeneration|apiTools|loops/core|agentMode/core|brandLogo|httpClient`
   on 20 open `AgentWebPro/agentweb` PRs: **empty.** Same A-005 pile:
   `#2871 #2861 #2832 #2563 #2060 #1584 #1076` (+ `emma/tools.ts` on
   `#2832 #1076 #689`).

2. **External composition is already HTTP — to localhost, into the 40k file.**
   `generate_image` execute (`apiTools.ts` L2096) `mcpFetch`s
   `POST /api/emma/generate-image`. `httpClient.ts` L94–97
   `getBaseUrl()` is `http://localhost:${PORT||3001}`; L63 dynamically
   imports `db.ts`. `emmaApi.ts` L174–182 does **not** call
   `imageGeneration.ts`; it `getAgentModeService()` (L25–28) then
   `svc.generateImage`. Policy lives at `agentModeService.ts` L28857
   (category, HITL, logo) and only then `await import('./imageGeneration')`
   (L28950). `emmaApi.ts` has **59** such god-object calls.

3. **A-008 does not need to touch the route.** The five prod importers
   plus the dynamic import inside `generateImage` all resolve the *old
   path*. Re-export pattern already exists (`services/swarm/index.ts`).
   A-006 as a fifth process would be a hop *after* L28857 or a rewrite
   that skips it — both split meter / C2PA / logo.

## DISCARD / rank

No rank change. A-006 stays discard with hop evidence in
`COMPOSITION.md`. A-007 first slice (`infrastructure.ts`) is confirmed
mcpFetch-only. Product READY unchanged (Q-014 is still the L2077 flag
on the same loopback; it does not add hops).

## Mapping evidence

`research/sdlc/COMPOSITION.md`.

## Next

Cycle 26: collision-only on `apiTools.ts` / `imageGeneration.ts` /
`loops/core`. Unsubscribe `agentweb-research-cycle` after `stop_after`
(2026-09-12T06:00:00Z).
