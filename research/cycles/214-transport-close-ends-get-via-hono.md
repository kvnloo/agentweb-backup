# Cycle 214 — `transport.close()` ends GET via Hono `writable.end()`

**Date:** 2026-09-12T04:18:00Z
**Question:** Cycle 213 folded
`await mcpShutdown` then `server.close`
into A-019. Vendored
`StreamableHTTPServerTransport.close()`
only runs
`_streamMapping.forEach(cleanup)`. Does
that actually end GET `/mcp`
`handleRequest` so unawaited
`server.close` can finish, or can
`close()` hang the same keep-alive
cycle 72 named?

**Answer:** **Cleanup ends GET.** GET’s
`cleanup` is `streamController.close()`.
Hono’s Node adapter then
`writable.end()`s. `close()` does **not**
await that end; Node `server.close`
still waits for the connection, which
is why the order is trigger-close then
`server.close`, not await-close as a
substitute. Local never uses
`enableJsonResponse` (only rehydrate).
Do not await `server.close` for this
hang. Do not add A-021.

## Evidence

Node `close()` is a one-line delegate.
The work is Web Standard:

```107:108:backend/node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js
    async close() {
        return this._webStandardTransport.close();
```

```604:613:backend/node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js
    async close() {
        // Close all SSE connections
        this._streamMapping.forEach(({ cleanup }) => {
            cleanup();
        });
        this._streamMapping.clear();
        this._requestResponseMap.clear();
        this.onclose?.();
    }
```

GET’s standalone stream stores this
cleanup (same file L228–239):

```
cleanup: () => {
    this._streamMapping.delete(this._standaloneSseStreamId);
    try { streamController.close(); } catch { /* already closed */ }
}
```

POST SSE (the Q-001 `data:` face; local
transport does **not** set
`enableJsonResponse`) uses the same
`streamController.close()` (L500–508).
JSON-mode cleanup (L458–460) only
deletes the map and does **not**
`resolveJson` — that transport is
rehydrate-only (`mcpSessionRehydration.ts`
L90), not on the local `sessions` Map
`mcpShutdown` iterates.

GET `handleRequest` is Hono
`getRequestListener` (`streamableHttp.js`
L9 / L126–139). For a live SSE body the
adapter awaits
`writeFromReadableStreamDefaultReader`.
When the Web stream is done it ends the
Node response:

```285:293:backend/node_modules/@hono/node-server/dist/index.mjs
  function flow({ done, value }) {
    try {
      if (done) {
        writable.end();
      } else if (!writable.write(value)) {
        writable.once("drain", onDrain);
      } else {
        return reader.read().then(flow, handleStreamError);
```

`close()` itself is sync cleanup. It
returns before Hono’s next `read()`
sees `{done:true}`. That is not a hang:
`server.close` waits for existing
connections (cycle 72). Triggering
`controller.close()` is what makes
those connections finite. Awaiting
`server.close` before
`CompleteLifecycleAction` is still
cycle 73 (unawaited today) and is
**not** the GET fix.

Local initialize (`mcpServer.ts`
L333–379) never passes
`enableJsonResponse`. Copying
rehydrate’s JSON mode onto the live
transport would change Q-001’s POST
SSE and would not close GET anyway
(GET is the standalone stream, not
JSON). `transport.onclose` (L382–387)
only `sessions.delete`s — it is not
the socket closer.

`gracefulShutdown.test.ts` still has
zero `mcpShutdown` hits. Source-scan
that file after the four-way wait
(cycle 213); this cycle adds no extra
step.

## First-slice correction (A-019 stays ready)

Step 4 from cycle 213 is sufficient for
the GET hang:

1–3. Unchanged (503 `tools/call`, GET
   405, `track` + `/generate` 503).
4. After the four-way wait,
   `await mcpShutdown` then
   `server.close`. Drop sibling SIGTERM.
   Do **not** await `server.close` to
   “finish GET.” Do **not** set
   `enableJsonResponse: true` on the
   live transport. Do not
   `sessionStore.delete`.

Do not edit `slack.ts`. Do not add HTTP.
Do not add A-021.

## Relation to A-002 / A-007 / A-008

A-019 is still the architecture item after
#2+#3. This cycle only proves the closer
cycle 213 named actually ends GET. Not
A-006. Q-001 / Q-014 / Q-003 stay ready.

## Next cycle candidate

JSON-mode `cleanup` does not
`resolveJson` (`webStandardStreamableHttp.js`
L458–460). File-level only: if a
rehydrate CallTool is still in
`track('mcpCallTool')` at drain
ceiling, does wrapping the handler
already cover it, or can that Promise
outlive `mcpShutdown` because the
transport is not on the local Map?
Do not add A-021. Do not un-ready
Q-001 / Q-014 / Q-003. Do not revive
A-006.
