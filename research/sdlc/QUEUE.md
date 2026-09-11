# Architecture / SDLC queue

Source of truth: `research/sdlc/queue.json`. **Not** the product queue.
Product implementation order is still Q-001 → Q-014 → Q-003.
`coding_unlocked: false`.

Thesis: `THESIS.md`. Comparison: `COMPARISON.md`. Module map:
`MODULE_MAP.md`. Services DAG: `SERVICES_DAG.md`. A-007 map:
`A-007-split-map.md`. Hops: `COMPOSITION.md`.

## Ranked (architecture track)

| Rank | ID | Score | Status | Title |
|---|---|---|---|---|
| 1 | A-001 | 32 | **ready** | Modular monolith thesis (this folder) |
| 2 | A-007 | 31 | **ready** | Split `apiTools.ts` — first file `tools/infrastructure.ts` |
| 3 | A-002 | 28 | **ready** | CI import boundary for `loops/core` |
| 4 | A-008 | 26 | **ready** | Folder-move creative cluster + re-export |
| — | A-005 | 23 | park | File-size ratchet — 7 PRs on `agentModeService.ts` |
| — | A-010 | 23 | park | codingAgent ↛ agentModeService (not a subprocess) |
| — | A-004 | 19 | park | Split `emma/tools.ts` after #2832 |
| — | A-003 | 16 | park | Wire `executeAgentStep` (Harsha / Q-010) |
| — | A-009 | 15 | park | Do not invert `llmClients` ↔ meter to copy OMP |
| — | A-006 | 6 | **discard** | HTTP nanoservice per tool |

Cycle 29: `"agentweb-tools"` → localhost `/mcp` is still in
`mcp_config.ts` but `initialize()` skips `isInternal` as circular.
A-006 stays discard. Hermes is client-only; AgentWeb is both.

## First SDLC coding (only after product unlock, and not instead of Q-014)

1. **A-002** — AST import guard on `loops/core` only (copy
   `sdkConstructionGuard.test.ts`). Allow exactly `orchestrator` /
   `instanceRunner` → `../index`. Do **not** copy forbid-all-services
   onto `agentMode/core` (`toolDispatch` imports the gateway).
2. **A-007** — `mcp/server/tools/infrastructure.ts` (five mcpFetch
   tools including `generate_image`). Not `content.ts` (that section
   dynamically imports `agentModeService`). Not 85 Hermes files.
3. **A-008** — `services/creative/` with re-export + `creative ↛ agentModeService` test.
4. **A-005** — only after the `agentModeService.ts` PR pile shrinks.

Never A-006. Never a Kubernetes slice of Emma as a first architecture PR.
