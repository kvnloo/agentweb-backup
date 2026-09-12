# Cycle 222 — skip-`send()` does not `stream.cleanup()`

**Date:** 2026-09-12T05:10:00Z
**Question:** Cycle 221: if cancelled
202s during the wait, Protocol
L351 skips `send()` and the
original POST SSE never gets a
JSON-RPC result. File-level only:
does that leave
`_requestToStreamMapping` so
`mcpShutdown` `close()` is still
the hang closer (cycle 214 GET vs
this POST stream), or does
skip-send already
`stream.cleanup()`?

**Answer:** **Skip-send does not
cleanup.** The only SSE closer on
a result is `send()` L712–714
after a JSON-RPC result/error.
Aborted `_onrequest` `return`s
without `send()`. Local POST
`tools/call` already returned HTTP
200 SSE; the stream stays in
`_streamMapping` until
`mcpShutdown` `close()` (same
`streamController.close()` as
GET). Do not treat cancelled as
stream cleanup. Do not add A-021.

## Evidence

Protocol skip is a bare
`return`. It does not call
`capturedTransport.send()`.
`finally` only deletes the abort
controller:

```351:401:backend/node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js
            .then(async (result) => {
            if (abortController.signal.aborted) {
                // Request was cancelled
                return;
            }
            const response = {
                result,
                jsonrpc: '2.0',
                id: request.id
            };
            // ...
                await capturedTransport?.send(response);
            }
        }, async (error) => {
            if (abortController.signal.aborted) {
                // Request was cancelled
                return;
            }
            // ...
        })
            .catch(error => this._onerror(new Error(`Failed to send response: ${error}`)))
            .finally(() => {
            this._requestHandlerAbortControllers.delete(request.id);
        });
```

`stream.cleanup()` runs only inside
`send()` when a result/error is
stored and every id on that stream
has a response:

```685:720:backend/node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js
        if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
            this._requestResponseMap.set(requestId, message);
            const relatedIds = Array.from(this._requestToStreamMapping.entries())
                .filter(([_, sid]) => sid === streamId)
                .map(([id]) => id);
            const allResponsesReady = relatedIds.every(id => this._requestResponseMap.has(id));
            if (allResponsesReady) {
                // ...
                else {
                    // End the SSE stream
                    stream.cleanup();
                }
                for (const id of relatedIds) {
                    this._requestResponseMap.delete(id);
                    this._requestToStreamMapping.delete(id);
                }
            }
        }
```

Skip-send never enters that
block. `_requestToStreamMapping`
and `_streamMapping` keep the
CallTool POST entry (set at
L495–511 when `hasRequests`).
Local never
`enableJsonResponse` (cycle 214).
`handleRequest` already returned
`Response(readable, { status: 200 })`
(L535). HTTP 200 SSE is already
on the wire.

POST cleanup is the same closer
as GET:

```500:508:backend/node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js
                    this._streamMapping.set(streamId, {
                        controller: streamController,
                        encoder,
                        cleanup: () => {
                            this._streamMapping.delete(streamId);
                            try {
                                streamController.close();
                            }
                            catch {
                                // Controller might already be closed
                            }
                        }
                    });
```

GET uses
`_standaloneSseStreamId`
(L228–239). POST uses a per-request
`streamId`. `close()`
`forEach(cleanup)` hits **both**
(`webStandardStreamableHttp.js`
L604–613). Cycle 214’s Hono
`writable.end()` after
`controller.close()` applies to
this orphaned POST SSE too.

`extra.closeSSEStream` is **not**
an A-019 hook. It is only
installed when `eventStore` is set
and protocol `>= 2025-11-25`
(L523–526). `mcp/` has zero
`eventStore` (cycle 219). Q-001
is `2025-06-18`.

Client timeout does not abort the
original POST fetch.
`StreamableHTTPClientTransport.send()`
does **not** await
`_handleSseStream(..., false)`
(L390). Timeout `cancel()`
(`protocol.js` L649–662) does not
abort `_abortController` (that is
`close()` L280–286). The client
still holds the POST SSE; the
server must `controller.close()`
it.

Rehydrate cannot skip-send via
this cancelled POST. Rehydrate
never `sessions.set` (cycle 215),
so the notification POST is a
**new** Protocol (cycle 221) or
404. JSON `resolveJson` still
runs when that handler
`send()`s. Skip-send is the
**local Map SSE** face only.

`cronJobRegistry.drain()` waits on
`inFlight` (handler return), not
on `_streamMapping`. After
skip-send, track() can be empty
while the POST SSE is still open.
`runDrain` today has **zero**
`mcpShutdown` before
`server.close` (L440). That is
why A-019 keeps
wait-then-`mcpShutdown` then
`server.close`: billed hop first,
then close GET **and** skip-send
POST streams so Node
`server.close` can finish.

## First-slice correction (A-019 stays ready)

Keep wait-then-`mcpShutdown`. Add:

- Do **not** treat Protocol
  skip-send (L351–355) as
  `stream.cleanup()`. It is not.
- Do **not** call
  `extra.closeSSEStream` from
  CallTool (unset without
  `eventStore`).
- Do **not** drop `mcpShutdown`
  after the wait because “cancelled
  already closed the POST”
  (it did not). GET and skip-send
  POST share `close()`.
- Do **not** 503
  `notifications/cancelled`
  (cycle 221). Copy
  `method === 'tools/call'`.

Do not wire `extra.signal`. Do not
add HTTP. Do not add A-021.

## Relation to A-002 / A-007 / A-008

A-019 is still the architecture
item after #2+#3. This cycle only
names the leftover POST SSE after
skip-send. Not A-006.

## Next cycle

`runDrain` `server.close` is
unawaited (L440) and
`CompleteLifecycleAction` does
not wait on it (cycle 73). After
skip-send, that POST SSE is still
a Node HTTP connection until Hono
`writable.end()`. File-level only:
is `mcpShutdown`’s sync
`forEach(cleanup)` enough for
`server.close` to see the
connection finish, or can ASG
`CompleteLifecycleAction` cut the
orphaned POST the same way cycle
73 named for GET?
