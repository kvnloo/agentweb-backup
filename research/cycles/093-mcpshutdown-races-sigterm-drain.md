# Cycle 93 — `mcpShutdown` races `runDrain` on SIGTERM

**UTC:** 2026-09-11T22:05:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 69: `mcpShutdown` is unused by `runDrain`. Cycle 92: the
inspector cannot open GET `/mcp` SSE. Is that closer therefore
dead, or do Hermes SIGTERM and the ASG path still hit it?

## Finding

**Still unused by `runDrain`. On SIGTERM it is not unused — it
runs first, and it closes rather than waits.** Cycle 92 only
killed the inspector’s GET. Hermes/Cursor still have a live GET
face (`MCP_DISCOVERY.md`, `mcpServer.ts` L508–531). A fifth
`listen()` would inherit both listeners.

### Two SIGTERM handlers, import order

`server.ts` L2 `import app from './app'` → `app.ts` L204
`setupMcpServer(app)` → `mcpServer.ts` L269–270
`process.on('SIGTERM'|'SIGINT', handleShutdown)` →
`shutdownAllSessions` (`transport.close()` every local session,
L245–257). Comment L260: “for use by main server.” `server.ts`
never calls `(app as any).mcpShutdown`.

`server.ts` L474–475 then registers the same signals for
`gracefulShutdown` → `runDrain`. Node fires **all** listeners in
registration order. SIGTERM therefore:

1. Closes inbound MCP transports (Hermes GET SSE **and** in-flight
   POST `CallTool`) immediately.
2. Then waits the four named drains (cycle 69), then `server.close()`.

`gracefulShutdown.test.ts` source-pins worker/cron/session before
`server.close` (L223–229). It has **zero** `mcpShutdown` hits. The
self-handler is the closer cycle 69 said not to call *from*
`runDrain` as a CallTool waiter — and SIGTERM already calls it
**before** the waiter.

### ASG vs SIGTERM are different

ASG (`asgLifecycleGuard.ts` L18–19 / L262–273) runs
`drainForShutdown` **before** SIGTERM. During that drain,
`mcpShutdown` still does not run — GET `/mcp` `setTimeout(0)`
(cycle 72) can still hold `server.close` (cycle 73, not awaited).
Inspector cannot create that GET (cycle 92). A real Hermes
Streamable HTTP session can (`MCP_DISCOVERY.md` L15). After CONTINUE,
the later SIGTERM finally closes those sockets *and* re-enters
`gracefulShutdown` (`drainPromise` already set, L368–370).

Direct SIGTERM / Ctrl-C (no ASG): step 1 aborts inbound
`generate_image` CallTool at the transport, then drain waits on
Agent Mode turns. Opposite of `chatbotTurn` (wait, then close).

OMP still **0.85.1** (`pi-ai` package.json this scan). Images still
`sideEffects` `images.js`. No HTTP-split there either.

### Why this is not a nanoservice

The in-process order is: track inbound CallTool, wait, then call
`mcpShutdown`, then `server.close`. Unregister the extra SIGTERM
listener or it will keep racing. A fifth `listen()` is not in
either handler (cycle 68). Do not delay Q-014 for this wrap.

## Queue effect

A-006 stays **discard**. Q-014 stays **ready**. Wrap CallTool after
#2 (cycle 70–71); when wrapping, call `mcpShutdown` after the wait
and drop the sibling `process.on` in `mcpServer.ts`. Do not treat
cycle 92 as “GET SSE is dead.”

## Next

Cycle 94: cheapest remaining. Candidate: `shutdownAllSessions`
clears only the **local** `sessions` Map (L257) — ENG-114
rehydrate store is a different closer. Do not un-ready Q-001 /
Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
