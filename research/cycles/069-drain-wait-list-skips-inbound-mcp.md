# Cycle 69 — drain waits on four named units; inbound MCP is not one

**UTC:** 2026-09-11T21:12:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 68: the ASG hook parks **this** process and calls
`drainForShutdown`. Cycle 58: that drain waits because mcpFetch is
this PORT. Does the wait list include inbound MCP `CallTool`
(Q-014 `generate_image`), or only Agent Mode / cron / voice?

## Finding

**The wait list is four named drains. Hermes `generate_image` is
not among them. `mcpShutdown` is advertised for the main server
and never called from `runDrain`.**

### What `runDrain` actually awaits

`server.ts` L397–420 (`Promise.all`):

1. `generateMarketingResponseWorkerService.shutdown()`
2. `cronJobRegistry.drain()`
3. `drainActiveSessionGenerations()`
4. `drainLiveVoiceToolExecutions()`

Then `server.close()`, `io.close()`, `agentModeService.shutdown()`
(MCP **client**, L458). ENG-1189 (`drainActiveSessionGenerations`
L1022–1030) is about Agent Mode turns’ *outbound* mcpFetch, not
inbound MCP.

### The missing waiter

`mcpServer.ts` L260–261: `(app as any).mcpShutdown = shutdownAllSessions`
—“for use by main server”. `server.ts` never calls it. Prod grep:
assignment + tests (`mcp.mcpServer.test.ts` L416, hermes-oauth
e2e L79).

L269–270: a **sibling** `SIGTERM`/`SIGINT` that **closes
transports**. It does not wait for in-flight `CallTool`. The ASG
path (cycle 68) drains **before** SIGTERM (`asgLifecycleGuard.ts`
L18–19), so that closer has not even run yet.

`mcpServerCore.ts` L88–120: `CallTool` →
`mcpToolRegistry.execute` with **no** `cronJobRegistry.track`.
Q-014 `generate_image` (`apiTools.ts` L2096–2108) is the same
localhost mcpFetch ENG-1189 exists to protect.

Contrast: `server.ts` L288–301 wrapped Emma chatbot in
`cronJobRegistry.track('chatbotTurn', …)` because it was “the one
path with no other in-flight coverage”
(`gracefulShutdown.test.ts` L249–254). Inbound MCP is the next
such path. Source-pinned drain tests enumerate worker / cron /
sessions / live voice / chatbotTurn — not `CallTool`.

A-006 as a fifth `listen()` would be a fifth wait-list miss, not
a fix. The in-process move (when coding) is copy `chatbotTurn`:
track `CallTool`, keep mcpFetch on this PORT. Do not call
`mcpShutdown` from `runDrain` as a substitute — that **closes**
sessions rather than waiting for `generate_image`.

## Queue effect

A-006 stays **discard** (new citation: Q-014 hop is already off
the drain wait list; a fifth process would not join it). Do not
un-ready Q-014 — listing is still the product slice; drain
coverage is architecture. A-017 stays park. No new A-id.

## Next

Cycle 70: cheapest remaining mapping. Do not un-ready Q-001 /
Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
