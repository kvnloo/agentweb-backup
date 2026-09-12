# Cycle 148 — Same KB name, different result cardinality: GG and Emma RAG hardcode 10; Emma tool / MCP default 5

**UTC:** 2026-09-12T00:28:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 147: GG `reason` never reaches Vertex. Does GG also
hardcode `maxResults=10` while Emma/MCP default 5? File-level.

## Finding

**Yes, and Emma disagrees with itself.** Cardinality is a
face policy, not a leaf port. HTTP-splitting the leaf would
still need each caller to pick 5 vs 10.

| Face | Citation | What the leaf / method sees |
|---|---|---|
| Growth Genius | `growthGeniusService.ts` L71 | **10**, hardcoded. Schema has no `max_results` (cycle 146). |
| Emma RAG | `chatbotService.ts` L5106 | **10**, hardcoded, after local embeddings (L5093). |
| Emma tool | `emma/tools.ts` L5594 | `args.max_results \|\| 5` into Agent Mode |
| MCP listed | `apiTools.ts` L1281 | `args.max_results \|\| 5` into Agent Mode via HTTP |
| Agent Mode method | L24032 default 5, L24050 `Math.min(maxResults, 10)` | Cap 10 after the caller default |

Hermes/OMP: one default on the handler. AgentWeb’s same
name already has two defaults (5 vs 10) **inside Emma**
(RAG vs tool) before Growth Genius and MCP join.

A fifth process for “search” cannot pick the number without
forking the contract again. Keep the Vertex leaf in-process
(ENG-1057). Do not add A-021. Do not change defaults on
this research turn.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-011 stays
**park**. A-006 stays **discard**. Do not add A-021. Q-001
stays **ready**. Q-014 stays **ready**.

## Next

Cycle 149: cheapest remaining. Candidate: Agent Mode
collects up to `limitedMaxResults` **per source** then
`results.slice(0, limitedMaxResults)` (L24230–24233). A
default-5 call can still walk Drive+ClickUp at 5 each, then
throw most of it away. File-level. Do not un-ready Q-001 /
Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
