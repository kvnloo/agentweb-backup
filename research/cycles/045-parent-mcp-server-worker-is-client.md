# Cycle 045 — Parent singleton vs worker instance; MCP server is parent-only

UTC: 2026-09-11T19:58Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **Collision** (20 open PRs). Worker / `app.ts` MCP setup still empty
   of competing PRs.

2. **Two `AgentModeService` instances per EB box, different jobs.**

   | Process | Construction | `initialize()` | Role |
   |---|---|---|---|
   | Parent | `server.ts` L6 singleton | L594 | MCP **server** (`app.ts` L204 `setupMcpServer`), `emmaApi` `generateImage`, Emma **chatbot** in-process (L288–291: “no fork”) |
   | Worker | `workers/generateMarketingResponseWorker.ts` L16 `new AgentModeService()` | L36 | Agent Mode **chat loop** `generateMarketingResponse` L123. Worker has **no** `setupMcpServer` (grep empty under `workers/`) |

   Worker L39: “MCP servers loaded” means **outbound clients**
   (`initializeMcp`). Parent does that too unless `IS_MCP_SERVER==='true'`
   (`agentModeService.ts` L1593–1597). That env is **never set** anywhere
   else in this tree — both sides always load vendor MCP clients.

3. **Q-014 is the parent MCP *server* `tools/list`.** Hermes talks to
   `setupMcpServer(app)`. The worker does not list tools to Hermes. In-app
   `generate_image` stays on the worker instance’s emma registry (cycle 38).
   Do not dual-register into the worker. Do not move the MCP HTTP server
   into the fork (health checks + OAuth refresh live on the parent:
   `server.ts` L586–599).

4. **Hermes/OMP.** One process, MCP clients outbound. AgentWeb is
   already: MCP **server** (parent) + MCP **clients** (parent *and*
   worker) + `fork` of the god object. Cutting-edge is #2393 ports and
   A-002, not a third HTTP image process that both instances would call.

## DISCARD / rank

No rank change. A-006 stays discard. Product READY unchanged.

## Mapping evidence

`COMPOSITION.md` parent singleton vs worker instance. `THESIS.md`
runtime table. A-006 why.

## Next

Cycle 46: collision-only unless a cheaper mapping exists. Unsubscribe
after `stop_after` (2026-09-12T06:00Z).
