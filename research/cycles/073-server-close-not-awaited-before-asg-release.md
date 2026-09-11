# Cycle 73 — server.close() is not in the await the ASG hook waits on

**UTC:** 2026-09-11T21:20:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 72: ordered drain is wait CallTool → `mcpShutdown` →
`server.close()` → `CompleteLifecycleAction`. Does `runDrain`
actually *wait* for close before the guard releases the instance?

## Finding

**No. `server.close()` and `io.close()` are fire-and-forget
callbacks. The ASG hook awaits `onTerminating()`, then
`completeLifecycleAction`. Drain can resolve while GET `/mcp` SSE
still holds the socket.**

### What the hook waits on

`asgLifecycleGuard.ts` L212–214 / L262–273: `onTerminating` is
“expected to perform the graceful drain. Once it resolves, the
lifecycle action is completed.” `server.ts` L572–574 passes
`() => drainForShutdown('ASG termination')`.

`runDrain` after the four-way wait (`server.ts` L438–462):

```
server.close((err) => { ... });   // not a Promise
io.close((err) => { ... });       // not a Promise
await agentModeService.shutdown(); // MCP *client* only (L1729–1743)
await flushTelemetry();
```

No `await` of close. ENG-1189’s source-pinned test
(`gracefulShutdown.test.ts` L223–230) only asserts
`drainCallIndex < serverCloseIndex` — order in the file, not
that close is joined.

Cycle 72’s GET `/mcp` (`mcpServer.ts` L508–531, timeout 0) is why
the callback may **never** fire: Node `close()` waits for existing
connections. Drain still returns. The hook logs “drained —
lifecycle action completed, instance may terminate” (L288) with
Hermes SSE still open. SIGTERM’s `process.exit(0)` (L471) then
kills the process; the ASG path does not exit — it releases the
instance.

`agentModeService.shutdown()` is the wrong closer for inbound MCP:
it shuts `mcpClientService` (vendor clients), not
`app.mcpShutdown`.

In-process order (when coding, after #2, not instead of Q-014):
track CallTool → `mcpShutdown` (so SSE dies) → **await**
promisified `server.close()` / `io.close()` → return so the hook
completes. A-006 as a fifth `listen()` would copy this una waited
close unless that await is added here first.

Hermes/OMP: process exit *is* the close. AgentWeb’s cutting-edge
SDLC is a **joined** drain in the composition root, not a second
HTTP server.

## Queue effect

A-006 stays **discard** (new citation: the hook already treats
drain resolve as “sockets gone”; a fifth process would lie the
same way). Q-014 stays **ready**. A-017 stays park.

## Next

Cycle 74: cheapest remaining mapping. Do not un-ready Q-001 /
Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
