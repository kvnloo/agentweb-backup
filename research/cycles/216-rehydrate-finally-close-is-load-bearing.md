# Cycle 216 — rehydrate `finally close()` is load-bearing for leftover JSON maps

**Date:** 2026-09-12T04:32:00Z
**Question:** Cycle 215: JSON
`resolveJson` (`webStandardStreamableHttp.js`
L706) does **not** call
`stream.cleanup()`. The SSE else
branch does (L712–714). Mapping stays
until `finally` `close()`
(`mcpSessionRehydration.ts` L115–118).
File-level only: is that `finally`
load-bearing for memory, or does a
skipped `close()` after a resolved
JSON CallTool still leak the
WebStandard transport?

**Answer:** **Keep the `finally`.**
After `resolveJson`, `close()` is
delete-only and **cannot hang**.
`send()` already dropped
`_requestToStreamMapping` and
`_requestResponseMap`. What remains
is `_streamMapping` (one entry per
JSON `handleRequest`: priming
initialize + the real CallTool).
Skipping `close()` after a resolved
JSON CallTool does **not** leak an
Express/Hono socket — JSON already
returned a `Response` and
`writeWebResponse` `res.end`s.
The leftover maps die with the
one-shot object **unless** we
`sessions.set` it (forbidden, cycle
215). JSON on a **reused** transport
would accumulate one `_streamMapping`
entry per POST — another reason not
to `enableJsonResponse` on the live
Map (cycle 214). Do not drop the
`finally` to “avoid the hang.” Do
not add A-021.

## Evidence

JSON `handleRequest` stores
`{ resolveJson, cleanup }` and
returns a Promise that settles only
via `resolveJson`:

```453:470:backend/node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js
            if (this._enableJsonResponse) {
                // For JSON response mode, return a Promise that resolves when all responses are ready
                return new Promise(resolve => {
                    this._streamMapping.set(streamId, {
                        resolveJson: resolve,
                        cleanup: () => {
                            this._streamMapping.delete(streamId);
                        }
                    });
                    for (const message of messages) {
                        if (isJSONRPCRequest(message)) {
                            this._requestToStreamMapping.set(message.id, streamId);
                        }
                    }
                    for (const message of messages) {
                        this.onmessage?.(message, { authInfo: options?.authInfo, requestInfo });
                    }
                });
            }
```

When every related response is
ready, JSON calls `resolveJson` and
**skips** `cleanup`. SSE calls
`cleanup`. Both then drop the
request maps:

```696:720:backend/node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js
                if (this._enableJsonResponse && stream.resolveJson) {
                    // All responses ready, send as JSON
                    // ...
                        stream.resolveJson(new Response(JSON.stringify(responses[0]), { status: 200, headers }));
                    // ...
                }
                else {
                    // End the SSE stream
                    stream.cleanup();
                }
                // Clean up
                for (const id of relatedIds) {
                    this._requestResponseMap.delete(id);
                    this._requestToStreamMapping.delete(id);
                }
```

`close()` is the only remaining
JSON `cleanup()` on this path
(`forEach` then `clear`, L604–613).
After `handleRequest` has returned,
that `cleanup` is delete-only. It
does not call `resolveJson`. The
Promise is already settled, so this
is the **safe** window (cycle 215’s
hang is `close()` **during**
in-flight, when cleanup drops the
resolver without firing it).

Rehydrate uses that window:

```99:118:backend/src/mcp/server/mcpSessionRehydration.ts
  try {
    await transport.handleRequest(buildRequest(INITIALIZE_BODY));
    await transport.handleRequest(
      buildRequest(INITIALIZED_NOTIFICATION, sessionId, PRIMING_PROTOCOL_VERSION),
    );
    const webResponse = await transport.handleRequest(
      buildRequest(body, sessionId, clientProtocolVersion),
      { parsedBody: body },
    );
    await writeWebResponse(webResponse, res);
  } finally {
    await transport.close().catch(() => {
      /* best-effort teardown — the request response is already sent */
    });
  }
```

Two JSON `handleRequest`s leave
two `_streamMapping` entries
(initialize + CallTool). The
initialized notification is
requests-empty and returns 202 with
no mapping (L436–441). `close()`
then deletes both leftovers and
fires `onclose`.

`Protocol.connect`
(`protocol.js` L215–243) owns the
transport and wires `onclose` to
`_onclose` (L245–257: drop
`_transport`, reject leftover
**outbound** `_responseHandlers`).
`Protocol.close()` is
`this._transport?.close()` (L479–481).
Rehydrate never calls `server.close()`;
`transport.close()` is enough because
`connect` already wired `onclose`.
Inbound CallTool does not leave a
`setTimeout`: `_setupTimeout` is for
outbound `this.request()`;
`_requestHandlerAbortControllers`
is already `delete`d in the handler
`finally` (L399–401) by the time
`handleRequest` returns.

Skipping `close()` after that
return:

- Does **not** hold the Express
  socket (`writeWebResponse` L133
  `res.end`).
- Does **not** leave a live HTTP
  `ReadableStream` (JSON has no
  `controller`; SSE cleanup L500–508
  is the GET hang cycle 214 named).
- **Does** leave `{resolveJson,
  cleanup}` on `_streamMapping` until
  GC. Server ↔ transport is a
  `onmessage` cycle; both are
  function-local. `mcpToolRegistry`
  is a module singleton — each
  `createMcpServer` does not copy
  the catalog.
- **Would accumulate** if the same
  transport were reused (one JSON
  POST → one leftover streamId).
  Rehydrate is never cached (L15–18).
  Local initialize never sets
  `enableJsonResponse` (`mcpServer.ts`
  L333). Do not `sessions.set` this
  object; do not flip the live
  transport to JSON to “share”
  `mcpShutdown`.

Tests (`mcpSessionRehydration.test.ts`
L99–113) still pin tools/call 200,
not `close()` or map size. The
`finally` is the comment’s
“never cached/accumulated” contract.
Keep it.

AgentWebPro 2026-09-12 still empty
on `mcpSessionRehydration.ts` /
`mcpServerCore.ts` / `mcpServer.ts` /
`cronJobRegistry.ts` / `server.ts` /
`apiTools.ts`. Occupied elsewhere
unchanged (`emma/tools.ts` #2832,
`app.ts` #2271, Slack #2393).

## First-slice correction (A-019 stays ready)

1–4 unchanged. Keep:

- Wrap `CallTool` in `mcpServerCore`.
- Do **not** `sessions.set` a
  rehydrate transport.
- **Keep** `finally { await
  transport.close() }` after
  `handleRequest` returns. Do not
  drop it to avoid the hang.
- Do **not** set
  `enableJsonResponse` on the live
  local transport (JSON leftover
  maps would accumulate there).

Do not edit `slack.ts`. Do not add HTTP.
Do not add A-021.

## Relation to A-002 / A-007 / A-008

A-019 is still the architecture item
after #2+#3. This cycle only proves
the `finally` is leftover-map
cleanup, not a cancel and not an
HTTP leak. Not A-006. Q-001 /
Q-014 / Q-003 stay ready.

## Next cycle candidate

`Protocol._onclose` (`protocol.js`
L245–257) does **not** abort
`_requestHandlerAbortControllers`
(set at L302–303). `transport.close()`
during in-flight hangs JSON
`handleRequest` (cycle 215) **without**
firing CallTool `extra.signal`.
File-level only: does `mcpShutdown`
ever cancel Q-014 `generate_image`,
or is the A-019 wait the only billed
hop? Do not add A-021. Do not
un-ready Q-001 / Q-014 / Q-003. Do
not revive A-006.
