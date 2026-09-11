# Code-quality comparison for agentic development

Snapshot: 2026-09-11T18:45Z, OMP DAG refreshed **19:17Z** (cycle 30). Hermes
and OMP via public GitHub; AgentWeb from this clone.

## Size (what an agent must hold)

| Surface | Lines or bytes | Notes |
|---|---|---|
| AgentWeb `agentModeService.ts` | **40,571 lines** | June strangler baseline was 24,205. Grew ~16k after “extraction.” |
| AgentWeb `agentModeController.ts` | 14,929 | Locks, scheduled chats |
| AgentWeb `db.ts` | 11,671 | Harsha / data-plane |
| AgentWeb `emma/tools.ts` | 9,780 | In-app registry, one file |
| AgentWeb `agentMode/` (extracted) | 10,167 prod+tests mixed | `core/toolDispatch.ts` 1,409 is the biggest extracted chunk |
| `executeAgentStep` | skeleton **throws** | `core/agentStep.ts` L48–55 |
| Hermes largest Python | ~392 KB `plugins/platforms/telegram/adapter.py` | Still big, but **plugins**, not the loop |
| Hermes `tools/` | many files, self-register | Documented acyclic import: registry ← tools ← model_tools |
| OMP `@earendil-works/pi-ai` etc. | bun **packages/** | `pi-ai`, `pi-agent-core`, `pi-coding-agent` (scope renamed from `@oh-my-pi`, cycle 30) |
| OMP largest TS | `packages/coding-agent/src/session/agent-session.ts` **445 KB** | They also have god files; they **contain** them in a package |
| OMP README claim | ~80k lines Rust core | `crates/pi-builtins`, `pi-shell` |

**Read:** OMP/Hermes are not “small files everywhere.” They are **bounded
packages** so a coding agent can open `packages/agent` without `db.ts`.
AgentWeb’s extracted `agentMode/core` is the right direction and is
incomplete; the monolith is still the default place to add features.

## Topology

```
Hermes:     CLI / gateway / ACP  ──► AIAgent ──► registry ──► tools/*.py
                                     (one process; registry.py has no tool imports)

OMP:        coding-agent CLI    ──► pi-agent-core ──► pi-ai ──► pi-catalog
            (package.json this cycle: ai does **not** depend on agent-core)

AgentWeb:   customer-portal (other repo)
            partner-portal EB  ─┐
            backend EB        ─┼─► parent I/O (HTTP, Socket.IO, cron, MCP server)
            agent-engine VM    ─┤   + fork worker compute (same 40k class)
            remotion-lambda    ─┘   MCP loopback: localhost → emmaApi → generateImage
            loops/index.ts      ──► ./core/types only (cycle 35; Hermes registry)
            app.ts L118–120     ──► instances register (explicit, not discover)
            mcp/server/registry ──► already imports evaluationPolicy (not loops-clean)
            mcp/client ↛ mcp/server (cycle 56; OMP DAG already true)
            chatbot on parent   ──► still executeTool (cycle 46; hexagon leaks)
            app.ts → crm.ts L24 ──► server.ts (cycle 59; IoPort too small)
```

## OMP workspace DAG (live 2026-09-11T19:17Z `earendil-works/pi` **0.85.1**)

Cycle 20 used `@oh-my-pi/*`. npm scope is now `@earendil-works/*`. Arrow
unchanged: `pi-ai` does **not** depend on `pi-agent-core`.

| Package | Depends on `@earendil-works/*` (0.85.1) | Must not depend on |
|---|---|---|
| `pi-ai` | pi-telemetry; **no** agent-core | **agent-core** |
| `pi-agent-core` | **pi-ai**, chord, pi-telemetry | coding-agent |

Live `earendil-works/pi` `@earendil-works/pi-ai` **0.85.1** (cycle 54
reconfirm). Arrow unchanged: `pi-ai` does **not** depend on `pi-agent-core`.
`sideEffects` include `./dist/images.js` and
`./providers/images/register-builtins.js` — images are an in-process
submodule of the leaf package (A-008, not A-006).

## Agentic SDLC practices

| Practice | Hermes / OMP | AgentWeb |
|---|---|---|
| Documented target loop | Yes | `AGENTMODE_MIGRATION.md` — **stale scorecard** (24k vs 40k) |
| Characterization tests | pytest volume | `backend/src/__tests__/agentMode/characterization/` exists |
| Eval / bench on tools | OMP “benchmaxxed” edits; metaharness package | `loops/` framework; human eval for images (not a router) |
| Module boundary in CI | package graph / AST `discover_builtin_tools` | **No** (A-002 sketch only) |
| Skills as files | `skills/` + optional-skills | Skills in system prompt + DB `foundation_tools` |
| MCP | Client (`mcp_tool.py` skipped by discover) | Server for Hermes **and** client to vendors; self `"agentweb-tools"` **skipped** (`mcpClientService.ts` L420–432) |

## Implications (not a port)

- Do not copy Hermes’ Telegram adapter size into Emma.
- Do not copy OMP’s Rust natives.
- Do copy: **package boundaries, registry import DAG, section-file MCP
  (ENG-982) then one-tool-per-file later, keep the loop in-process, MCP
  as the *external* nanoservice bus.** Do not copy Hermes’ 1-file-per-tool
  **or** `discover_builtin_tools` as the *first* A-007 PR
  (`A-007-split-map.md`). `loops/adapters/awsAdapters.ts` is the host
  package; do not import it from `core/`.
- `loops/core/ports.ts` is closer to OMP `pi-agent-core` than
  `agentModeService.ts` is. `LoopPorts` (L143–150) is six injected
  interfaces wired at `productionLoopPorts()` — that is how nanoservices
  already compose here. Promote that pattern; don’t invent K8s.
- Cycle 39: Hermes would expose **one** `generate_image` schema.
  AgentWeb already has two (Emma camelCase + HITL vs MCP snake_case
  HTTP adapter). That is composition drift, not a reason to add a
  fifth process. Q-014 lists the adapter; A-011 parks unifying it.
- Cycle 46: Hermes keeps sockets and the loop in one process. AgentWeb
  already split parent **I/O** from worker **compute**, then left Emma
  chatbot `executeTool` on the parent. Do not HTTP-split `generateImage`
  (three faces: parent MCP, parent chatbot, worker chat).
- Cycle 47: Hermes one `tools/list`. AgentWeb three catalogs for
  `generate_image` (MCP `internal`, chatbot `images` page, Agent Mode
  skills — not foundation). Q-014 lists MCP; A-014 parks copying the
  other catalogs.
- Cycle 48–49: AgentWeb `ListTools` has no skill gate. Lazy auth
  (ENG-984) may list to strangers; `ANONYMOUS_TOOLS` is empty so they
  cannot run. Hermes OAuth (Q-001) is still the execute path.
- Cycle 54: ENG-982 `workflowTools.ts` is mixed-identity (`adminClientScope`
  for `emma_get_account_status`). A-007 copies mcpFetch shape, not that
  import. OMP 0.85.1 still registers images inside `pi-ai`.
- Cycle 55: remotion-lambda is Chromium/ffmpeg isolation;
  `recordVendorUsage` stays in `remotionService`. `imageGeneration.ts`
  is already the host adapter (vendor HTTP). Do not copy the Lambda
  process onto images.
- Cycle 56: `mcp/client` ↛ `mcp/server` (prod). Shared
  `anonymousToolAccess.ts`. Do not HTTP-split; park A-016 until A-002.
- Cycle 57: `app.ts` is the composition root. #2271 owns its route table.
  A-007 attaches at `mcpServerCore`, not `app.ts`.
- Cycle 58: `server.ts` drain (ENG-1189 L404–413) waits on in-flight
  mcpFetch before `server.close()`. Hermes: one process, no second listen().
- Cycle 59: `crm.ts` L24 / worker L184 / `crmEnrichmentService` L67
  import `server.ts` despite `registerIo`. Hermes packages do not import
  the CLI for sockets. Park A-017 (expand `MinimalIo`, not HTTP).
- Cycle 60: A-017 is `getFathomLinearPort` (`fathomWebhook.ts` L39),
  not `LoopPorts`. `chatSocketHandler` already extracted from `server.ts`
  (ENG-1222 L17–20). Do not put live rooms on the loop package.
- Cycle 61: AgentWebPro still empty on `apiTools.ts` / `loops/core` /
  `sessionSockets.ts`. `app.ts` is now #2271 **and** #1814.
- Cycle 62: one `socket.join` (`server.ts` L186 `user:`). CRM uses
  `socket.id`; codingAgent emits `sessionId` with no join. A-017 is a
  passthrough, not a room enum.
- Cycle 63: `gtmPlan.ts` L12–13 / L1495 documents dynamic
  `import('../server')`. Ten such sites plus cycle-59 requires.
  Partner-portal GTMPlans listens with no client join.
- Cycle 64: worker IPC already splits SSE (`type:'progress'`) from
  Socket.IO (`type:'socketEmit'`). `RunEmitter` typed sink is a no-op.
- Cycle 65: `sseProgress` Maps are parent-heap only (same as
  `instanceState` — no Redis). Chatbot is per-socket `'message'`.
- Cycle 66: `keyedMutex.ts` L12–15 + `activeSessionGenerations` Set.
  A fifth process would race the claim. Do not Redis-ify the lock.
- Cycle 67: ENG-114 — no sticky routing. Scale-out is Dynamo metadata
  + in-process rehydrate, not HTTP-per-tool.
- Cycle 68: ASG does not wait on SIGTERM drain (`asgLifecycleGuard.ts`
  L4–16, session `d7e4863c`). Hook + `drainForShutdown` are this
  `listen()`. Hermes/OMP: one process, no ASG hook.
- Cycle 69: `runDrain` awaits worker / cron / sessions / live voice
  (`server.ts` L397–420). Inbound MCP `CallTool` (Q-014) is not
  tracked. Chatbot was wrapped (`chatbotTurn`, L288–301); MCP was
  not. Hermes keeps the tool in-process so there is no second hop
  to drain.
- Cycle 70: two inbound MCP faces (local Map vs ENG-114 rehydrate)
  share `CallTool`. Wrap that once. Node `server.close()` is not
  the waiter for inner mcpFetch.
- Cycle 71: AgentWebPro empty on `mcpServerCore.ts` /
  `cronJobRegistry.ts` / `mcpServer.ts` / `asgLifecycleGuard.ts`.
  Wrap is mergeable after #2, not instead of Q-014.
- Cycle 72: local GET `/mcp` SSE (`mcpServer.ts` L508–531) hangs
  `server.close()`. Ordered drain: wait CallTool, then
  `mcpShutdown`, then close. Hermes has no inbound SSE.
- Cycle 73: `server.close((err) => …)` is not a Promise. The ASG
  hook awaits drain then `CompleteLifecycleAction`. Source-pinned
  ENG-1189 tests order, not join. Hermes exit *is* close.
