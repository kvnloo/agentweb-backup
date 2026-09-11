# Cycle 046 — Parent is I/O; worker is compute (incomplete hexagon)

UTC: 2026-09-11T20:00Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **Collision** (20 open AgentWebPro PRs). Worker /
   `generateMarketingResponseWorkerService.ts` / `instanceState.ts` /
   `apiTools.ts` / `imageGeneration.ts` still empty of competing PRs.
   Still avoid: `emma/tools.ts` (#2832 #1076 #689),
   `sdkConstructionGuard.test.ts` (#2563), `agentModeService.ts` pile
   (#2871 #2861 #2832 #2563 #2060 #1584 #1076), Slack `routes/slack.ts`
   (#2393).

2. **The existing fork is already hexagonal I/O vs compute, not a
   nanoservice.** Cycle 44–45 named the two `AgentModeService` instances.
   This cycle names the *roles*.

   | Process | Role | Citations |
   |---|---|---|
   | **Parent (I/O)** | HTTP, Socket.IO, cron, MCP HTTP server, OAuth refresh | `server.ts` L563 `shouldBootstrapBackgroundJobs()`; L586 OAuth scheduler; `app.ts` L204 `setupMcpServer`; `instanceState.ts` L10–11 cron flag is **in-memory** (agent-engine reroutes `/run-scheduled-chats` on drain) |
   | **Worker (compute)** | Agent Mode chat loop only | `workers/generateMarketingResponseWorker.ts` L16 `new AgentModeService()`; L123 `generateMarketingResponse`. Grep under `workers/`: **no** `setupMcpServer`, **no** `shouldBootstrapBackgroundJobs`, **no** `listen(` |

   Worker L115–119: `socketEmit` IPC because “The worker has no Socket.IO
   server.” Parent `generateMarketingResponseWorkerService.ts` L181–189
   receives that IPC and `require('../server'); io.to(room).emit(...)`.
   Fork purpose is event-loop isolation so health checks stay live
   (`agentModeController.ts` L8254–8256), **not** a package boundary.

3. **The hexagon leaks on purpose: Emma chatbot stays on the I/O process
   and still runs tools.** `server.ts` L288–291: chatbot turn is
   **in-process, no fork**. `chatSocketHandler.ts` L21 →
   `chatbotService.generateChatResponse` → L5461
   `agentModeService.executeTool(...)`. That is the **parent singleton**
   (cycle 45), including `generate_image` policy when the sidebar asks
   for an image. Agent Mode forked to keep Express healthy; chatbot was
   kept on parent to avoid a *second* IPC path (the worker already invented
   `socketEmit`).

4. **Hermes / Oh My Pi / cutting-edge SDLC.** Hermes
   `run_agent.py` keeps sockets **and** the tool loop in **one** process;
   MCP is outbound. OMP packages stay in-process. AgentWeb already paid
   for a process split and then loaded the same 40k class on both sides.
   Cutting-edge here is still modular-monolith packages + ports
   (#2393, A-002), not HTTP-splitting `generateImage`. That method is
   called from **three** faces today:

   | Face | Process | Hop |
   |---|---|---|
   | MCP `tools/call` (Q-014 lists this) | Parent | `apiTools.ts` mcpFetch → `emmaApi` → `generateImage` |
   | Emma sidebar chatbot | Parent | `executeTool` in-process (no HTTP, no fork) |
   | Agent Mode chat | Worker | emma registry → `generateImage` in-process |

   A fifth HTTP image process would be a client of **both** OS processes
   and would still miss leaf callers (cycle 36). Hermes would not do
   this.

## DISCARD / rank

No rank change. A-006 stays **discard** (new citation: parent=I/O,
worker=compute, chatbot leak on parent). Product READY unchanged
(Q-001 / Q-014 / Q-003). Architecture order still A-002 → A-007 → A-008.

## Mapping evidence

`COMPOSITION.md` I/O vs compute. `THESIS.md` process table.
`COMPARISON.md` topology. `MODULE_MAP.md` EB-box processes.
`queue.json` A-006 why.

## Next

Cycle 47: collision-only unless a cheaper mapping exists. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006. Unsubscribe
`agentweb-research-cycle` after `stop_after` (2026-09-12T06:00Z).
