# Cycle 72 — local GET /mcp SSE is why mcpShutdown must follow the wait

**UTC:** 2026-09-11T21:16:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycles 69–70: wrap `CallTool` so drain waits for Q-014 mcpFetch.
Cycle 67/70: rehydrate is “no lingering SSE.” After that wrap, would
`server.close()` still hang on a Hermes session that opened GET /mcp?

## Finding

**Yes, on the local face. GET `/mcp` disables timeouts and holds
the socket. `mcpShutdown` is the closer, and it must run *after*
the CallTool wait, not instead of it. Rehydrate does not have this
stream.**

### Local GET is a second live object

`mcpServer.ts` L508–531: GET `/mcp` is “SSE stream for
server-to-client notifications.” If the session is in the local
`Map` and `ownsLocalSession`:

```
res.setTimeout(0);
req.socket.setTimeout(0);
req.socket.setNoDelay(true);
req.socket.setKeepAlive(true);
await transport.handleRequest(req, res);
```

Node `server.close()` waits for existing connections. A keep-alive
SSE with timeout 0 is exactly the connection that never ends. Cycle
70’s “rehydrate is finite JSON” (`mcpSessionRehydration.ts` L15–18)
does **not** apply here — GET is refused unless `sessions.has`
(L516), so the cross-instance face has no SSE to hang.

### Order on this process

| Step | Today (ASG path, cycle 68) | In-process order |
|---|---|---|
| 1 | four-way `runDrain` wait | add `CallTool` via `cronJobRegistry.track` (cycles 69–70) |
| 2 | `server.close()` | **`mcpShutdown`** (`mcpServer.ts` L245–257) — close transports / SSE |
| 3 | `CompleteLifecycleAction` | then `server.close()` |

Today: ASG drain skips 1 (CallTool) and 2 (`mcpShutdown` is sibling
SIGTERM only, L269–270). Calling `mcpShutdown` *during* an
in-flight `generate_image` would abort the mcpFetch the wrap exists
to finish. A-006 as a fifth `listen()` would own a third GET /mcp
with no hook and no closer.

Hermes: MCP is an **outbound** client. AgentWeb is also an inbound
Streamable HTTP **server** with a sticky SSE GET. Cutting-edge
SDLC is still one process; the missing piece is ordered drain, not
a mesh.

## Queue effect

A-006 stays **discard**. Q-014 stays **ready**. Do not start the
wrap+close slice instead of Q-014 (cycle 71: files empty, still
after #2). A-017 stays park.

## Next

Cycle 73: cheapest remaining mapping. Do not un-ready Q-001 /
Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
