# Cycle 94 — `mcpShutdown` is local-only; ENG-114 store outlives SIGTERM

**UTC:** 2026-09-11T22:10:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 93: SIGTERM `shutdownAllSessions` `transport.close()`s inbound
CallTool before `runDrain`. Does that closer also evict ENG-114
session metadata, or can the next instance rehydrate the same
Hermes session id — and would a fifth `listen()` change that?

## Finding

**Local Map only. The durable mirror is not deleted on shutdown or
stale cleanup.** Client `DELETE /mcp` is the only production
`sessionStore.delete`. With `MCP_SESSION_STORE=dynamo`, SIGTERM
aborts this instance’s transport and leaves `AW-MCPSessions` so
the next box can `rehydrateAndServe` (cycle 67). That is the
scale-out contract, not a missing nanoservice. Do not add
`sessionStore.delete` to `mcpShutdown` to “finish” cycle 93.

### What shutdown actually clears

`mcpServer.ts` L245–257: `transport.close()` every local entry, then
`sessions.clear()`. No `sessionStore` call. `transport.onclose`
(L382–387) also only `sessions.delete(sid)`.

`cleanupStaleSessions` L215–235: same local-only close. Idle hour
(`SESSION_TIMEOUT_MS` L27) does not evict the shared row.

### What does evict the store

`sessionStore.delete` appears twice, both on `DELETE /mcp`
(L565 not-local-but-owned; L583 live-and-owned). Tests name that
ENG-114 AC #3 (`mcp.mcpServer.sessionStore.test.ts` L12). Initialize
**writes** the mirror (`sessionStore.set` L354–359, void /
best-effort). Rehydrate reads it (`L410` + `mcpSessionRehydration.ts`
L3–18): finite HTTP, one transport per in-flight request, no
lingering SSE.

Default store is still in-memory (`createMcpSessionStore` L205–210).
Process exit wipes that Map. Dynamo is the fleet path: rows survive
the instance that closed the live transport.

### Why this is not a nanoservice

Cycle 67: live `StreamableHTTPServerTransport` cannot be serialized.
A fifth `listen()` would be another process-local Map plus the same
Dynamo mirror — Hermes would still POST the next CallTool to a
random instance that rehydrates in-process. Q-014 `generate_image`
mcpFetch is loopback on **that** instance (cycle 70). Closing
Dynamo on shutdown would force a client-visible reinit and fight
ENG-114. Drain wrap (after #2): wait CallTool, then close local
transports, **leave the store**. Unregister the racing SIGTERM
(cycle 93). OMP still in-process packages; they do not HTTP-split
session metadata.

## Queue effect

A-006 stays **discard**. Q-014 stays **ready**. Do not park a
“delete Dynamo on SIGTERM” item. A-018 unchanged.

## Next

Cycle 95: cheapest remaining. Candidate: `sessionStore.set` is
void/best-effort (L350–353) — a persist failure only forfeits
rehydrate, never the local session. Confirm no other writer. Do
not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
