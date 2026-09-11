# Cycle 038 — Two generate_image executes; no npm workspaces

UTC: 2026-09-11T19:39Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **Collision** (20 open PRs). `apiTools` / `imageGeneration` /
   `loops/core` still empty. `emma/tools.ts` still owned by
   **#2832 #1076 #689** (A-004 / Q-004 stay off that file).

2. **Same tool name, two execute implementations — already composed.**

   | Face | Register | Execute |
   |---|---|---|
   | In-app Emma | `emma/tools.ts` L4996 / L5055–5075 | **direct** `agentModeService.generateImage(...)` (policy: category, HITL, persisted logo, then leaf) |
   | External MCP | `apiTools.ts` L2075 / L2096–2107 | **mcpFetch** `POST /api/emma/generate-image` (loopback into the same policy) |

   Hermes: one handler table. AgentWeb already has an HTTP face *in
   front of* policy for MCP. Q-014 only lists the MCP face
   (`internal: true` L2077). A-006 as another HTTP process would be a
   hop **after** L2096. Do not collapse the two executes into
   evaluationTools-style dual-register (cycle 37): Emma would then
   mcpFetch herself (the skip in `mcpClientService` exists to prevent
   that).

3. **Package layer is still missing, on purpose for slice one.**
   `backend/package.json` has **no** `workspaces` and **no**
   `dependency-cruiser`. OMP publishes bun packages (`pi-ai` ↛
   `pi-agent-core`). AgentWeb’s first SDLC moves are folders + AST
   guards (A-002 / A-008 shim), not a monorepo extract. Do not add
   npm workspaces instead of Q-014.

4. **A-009 line number drift.** `utils/llmClients.ts` imports
   `usageRecorderService` at **L33** (cycle 20 said L13). Arrow
   unchanged: utils → services/meter. OMP `pi-ai` does not depend on
   the agent package. Stay parked.

5. **Fifth type, not a fifth process.** `agentMode/core/types.ts`
   L91–95 `ToolRegistry` is the strangler interface (“Implemented by
   the monolith today”). Live catalogs are `McpToolRegistry` instances
   (cycle 37). A-003 wires `executeAgentStep`; do not invent a
   nanoservice to implement `ToolRegistry`.

## DISCARD / rank

No rank change. A-006 stays discard (MCP execute is already the HTTP
face). A-009 stays park (L33). Product READY unchanged.

## Mapping evidence

`COMPOSITION.md` two-execute table. `queue.json` A-009 L33.
`THESIS.md` package.json has no workspaces.

## Next

Cycle 39: collision-only unless a cheaper mapping exists. Unsubscribe
after `stop_after` (2026-09-12T06:00Z).
