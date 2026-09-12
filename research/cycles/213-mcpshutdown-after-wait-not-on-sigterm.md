# Cycle 213 — `mcpShutdown` after the wait; drop sibling SIGTERM

**Date:** 2026-09-12T04:12:00Z
**Question:** Cycle 212 left existing GET
SSE to a later slice: `runDrain`
(`server.ts` L438–446) still
`server.close`s without
`(app as any).mcpShutdown`. Does that
close belong in A-019’s first_slice, or
wait?

**Answer:** **Fold it into A-019
first_slice.** After the four-way wait,
`await (app as any).mcpShutdown?.()` then
`server.close`. **Remove**
`mcpServer.ts` L269–270 `process.on`
SIGTERM/SIGINT. Cycle 72 named the
order; cycle 93 named the race. This
cycle only decides it is the same PR
as the billed-image gate, not A-021.

## Evidence

`shutdownAllSessions` closes every local
transport and clears the Map. It does
**not** `sessionStore.delete` (cycle 94:
ENG-114 rows must outlive SIGTERM).
Exported as `(app as any).mcpShutdown`.
Tests call it directly
(`mcp.mcpServer.test.ts` L416–428).
`gracefulShutdown.test.ts` still has
**zero** `mcpShutdown` hits.

```245:270:backend/src/mcp/server/mcpServer.ts
  const shutdownAllSessions = async () => {
    clearInterval(cleanupInterval);
    const closePromises: Promise<void>[] = [];
    for (const [sessionId, session] of sessions.entries()) {
      closePromises.push(
        session.transport.close()
          .catch((err) => console.error(`[MCP] Error closing session ${sessionId}:`, err))
      );
    }
    await Promise.allSettled(closePromises);
    sessions.clear();
  };

  (app as any).mcpShutdown = shutdownAllSessions;

  const handleShutdown = async (signal: string) => {
    console.log(`[MCP] Received ${signal}, initiating graceful shutdown...`);
    await shutdownAllSessions();
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
```

Comment L260: “for use by main server.”
`runDrain` never calls it. After the
four-way wait it only
`server.close`s (unawaited) then
`io.close`:

```438:455:backend/src/server.ts
  // 4. Stop accepting new HTTP connections — safe now that in-flight
  //    self-calls above have had their chance to complete.
  server.close((err) => {
    if (err) {
      console.error('Error closing HTTP server:', err);
    } else {
      console.log('HTTP server closed');
    }
  });

  // 5. Disconnect all Socket.IO clients (they auto-reconnect to the new instance)
  io.close((err) => {
```

POST CallTool and GET SSE share **one**
`StreamableHTTPServerTransport` per
session (`mcpServer.ts` L313 reuse;
GET L530 `sessions.get(sessionId)!.transport`).
Closing that object during an in-flight
Q-014 `generate_image` mcpFetch aborts
the billed hop the `track('mcpCallTool')`
wait exists to finish. So
`mcpShutdown` **follows** the wait, it
does not replace it.

Two SIGTERM listeners. Import order
registers the closer **first**:
`server.ts` L2 `import app from './app'`
→ `app.ts` L204 `setupMcpServer(app)`
→ `mcpServer.ts` L269, then
`server.ts` L474–475
`gracefulShutdown`. Node fires **all**
listeners in registration order. Sunday
OS/cgroup SIGTERM (cycle 115, ENG-201)
therefore `transport.close()`s the
shared transport **before**
`cronJobRegistry.drain()` can wait on
`mcpCallTool`. Opposite of
`chatbotTurn` (`server.ts` L301 wrap,
then close after the wait).

The ASG hook is the other face. It
calls `drainForShutdown` **before any
SIGTERM** (`asgLifecycleGuard.ts`
L18–21, L262–273). During that drain
the sibling `process.on` never fires.
Without a `runDrain` call,
`mcpShutdown` **never runs** on the
billed-image Immutable path. GET
`setTimeout(0)` (cycle 72) can still
hold `server.close` (cycle 73, not
awaited) until CONTINUE, then the
later SIGTERM finally closes sockets
*and* re-enters `gracefulShutdown`
(`drainPromise` already set,
L368–370).

Admission 503 / GET 405 stop **new**
hops. They do not end a stream already
open. Leaving close to a later PR
would ship a gate that still aborts
in-flight `generate_image` on Sunday
SIGTERM and still hangs GET SSE on
the ASG path.

## First-slice correction (A-019 stays ready)

After kvnloo#2, not instead of Q-014.
Same PR, ordered steps — **not** A-021:

1. POST `/mcp` `tools/call` → HTTP **503**
   (cycle 211). Unchanged.
2. GET `/mcp`: **405** if draining, not
   503 (cycle 212). Unchanged.
3. CallTool `track('mcpCallTool')` for
   the wait. `/generate` 503 before
   `tryClaim`. ListTools / initialize stay
   ungated. Unchanged.
4. **After** the four-way wait
   (`server.ts` L415–420),
   `await (app as any).mcpShutdown?.()`
   then `server.close`. **Remove**
   `mcpServer.ts` L269–270 (or no-op).
   Do **not** `sessionStore.delete` inside
   `shutdownAllSessions`. Source-scan
   `gracefulShutdown.test.ts` for
   `mcpShutdown` after the wait **and**
   zero `process.on('SIGTERM'` in
   `mcpServer.ts`.

Do not edit `slack.ts`. Do not add HTTP.
Do not add A-021.

## Relation to A-002 / A-007 / A-008

A-019 is still the architecture item after
#2+#3. This cycle only folds the closer
cycle 72/93 already named into the same
first_slice as the 503. Not A-006.
Q-001 / Q-014 / Q-003 stay ready.

## Next cycle candidate

Vendored `StreamableHTTPServerTransport.close()`
delegates to
`webStandardStreamableHttp.js` L604–613
(`_streamMapping.forEach(cleanup)`).
File-level only: does that `cleanup`
end the Node GET `handleRequest` so
unawaited `server.close` can finish, or
can close() hang the same keep-alive
cycle 72 named? Do not add A-021.
Do not start another S3/Referer matcher.
Do not un-ready Q-001 / Q-014 / Q-003.
Do not revive A-006.
