# Cycle 218 — `send()` after `close()` is Protocol `_onerror`, not `isError`

**Date:** 2026-09-12T04:50:00Z
**Question:** Cycle 217: after local `close()`
mid-CallTool, `send()` still runs
(signal not aborted). `close()`
clears `_streamMapping` not
`_requestToStreamMapping`, so
`send()` throws `No connection
established` (L672–694). File-level
only: is that throw inside Protocol
(Hermes hang) or `mcpServerCore`
`isError` **after** the leaf billed?

**Answer:** **The throw is inside
Protocol after the handler returned.
`mcpServerCore` already billed (or
already returned `isError` as a
result). Hermes does not get
`isError` — `_onerror` logs only.
The MCP SSE face is already closed.**
Wait-then-close is so `send()` can
usually complete; it is not a
vendor cancel (217) and it is not
a Hermes-delivery guarantee if
`close()` wins the race.

## Evidence

Protocol `_onrequest` captures the
transport at request start, then
chains handler → `send()`:

```342:401:backend/node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js
        Promise.resolve()
            .then(() => {
            // If this request asked for task creation, check capability first
            if (taskCreationParams) {
                // Check if the request method supports task creation
                this.assertTaskHandlerCapability(request.method);
            }
        })
            .then(() => handler(request, fullExtra))
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
            // handler THROW → send errorResponse
        })
            .catch(error => this._onerror(new Error(`Failed to send response: ${error}`)))
```

`capturedTransport` is captured at
L275. `connect` wires `transport.onclose`
to `_onclose` (L217–220). `_onclose`
(L245–257) sets `this._transport =
undefined` and does **not** abort
the handler `AbortController` (cycle
217). Optional chaining still calls
`send()` on the **closed** object.

AgentWeb CallTool cannot see that
throw. The handler **returns**
success or `{ isError: true }`:

```119:175:backend/src/mcp/server/mcpServerCore.ts
    try {
      const result = await mcpToolRegistry.execute(name, toolArgs, context);
      if (context.externalMcp && effectiveUserId) {
        void Promise.all([
          recordMcpToolUse({
```

```164:174:backend/src/mcp/server/mcpServerCore.ts
    } catch (error: any) {
      console.error(`[MCP] Error executing tool ${name}:`, error);
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
```

That is a successful handler
resolution. Protocol takes the
**first** `.then(send)` path even
for tool failures. `server.onerror`
is log-only:

```71:74:backend/src/mcp/server/mcpServerCore.ts
  server.onerror = (error) => {
    console.error('[MCP Error] Transport error:', error);
  };
```

`close()` vs `send()` on the local
Map transport:

```604:613:backend/node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js
    async close() {
        // Close all SSE connections
        this._streamMapping.forEach(({ cleanup }) => {
            cleanup();
        });
        this._streamMapping.clear();
        // Clear any pending responses
        this._requestResponseMap.clear();
        this.onclose?.();
    }
```

It does **not** clear
`_requestToStreamMapping`. Then:

```671:694:backend/node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js
        const streamId = this._requestToStreamMapping.get(requestId);
        if (!streamId) {
            throw new Error(`No connection established for request ID: ${String(requestId)}`);
        }
        const stream = this._streamMapping.get(streamId);
        if (!this._enableJsonResponse && stream?.controller && stream?.encoder) {
            // SSE write
        }
        if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
            // ...
            if (allResponsesReady) {
                if (!stream) {
                    throw new Error(`No connection established for request ID: ${String(requestId)}`);
                }
```

After `close()`, `streamId` is still
present; `stream` is `undefined`;
SSE write is skipped; L694 throws.
That throw is L370 → L398 `_onerror`,
**not** `mcpServerCore` L164.

Local initialize never
`enableJsonResponse` — this race is
SSE POST. JSON rehydrate is not on
the Map (cycle 215); its `finally
close()` is after `handleRequest`
already `resolveJson`'d (cycle 216).

Leaf billed **before** send: meter
after vendor success
(`imageGeneration.ts` L546–562),
then mcpFetch returns, handler
returns, **then** Protocol `send()`.

`drain()` does not await the
promises it tracks:

```62:70:backend/src/utils/cronJobRegistry.ts
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
```

`track()` (`L38–47`) deletes the
entry when the **tracked** promise
settles. `DRAIN_POLL_INTERVAL_MS`
is 2000 (`shutdownConstants.ts` L9).

Tests: `mcpSessionRehydration.test.ts`
L99–114 pins tools/call **200**, not
`close()`/`send()`. `gracefulShutdown.test.ts`
still has **zero** `mcpShutdown` hits.
Q-001 fixture asserts HTTP 200
(`hermes-oauth-client.py` L84), not
this race.

## First-slice correction (A-019 stays ready)

1, 3, 4 unchanged. Step (2): wrap
the **handler body's returned
promise** (what Protocol L350
awaits), not only `execute`.
Wrapping execute lets drain see
size 0 after mcpFetch while
`recordMcpToolUse` (void) +
`return` + Protocol `send()` still
run. Wrapping the handler return
still does **not** include
`Protocol.send()` — that is the
next `.then`. The 2s poll is the
usual gap that lets `send()`
complete; it is not a guarantee.

- Keep wait-then-`mcpShutdown` so
  `send()` can usually run.
- Do **not** expect
  `mcpServerCore` `isError` to catch
  a post-close `send()` throw.
- Do **not** wire `extra.signal`.
- Do **not** add HTTP. Do not add
  A-021.

## Relation to A-002 / A-007 / A-008

A-019 is still the architecture item
after #2+#3. This cycle only proves
the send-after-close throw is a
dropped SSE reply, not a billed
`isError`. Not A-006. Q-001 /
Q-014 / Q-003 stay ready.

## Next cycle candidate

If `close()` mid-CallTool, `send()`
throws and `_onerror` logs. File-level
only: does the vendored Hermes /
SDK Streamable HTTP **client** treat
a closed POST SSE as retry/reinit
(404) vs terminal, and does the
Q-001 fixture ever see that? Do not
add A-021. Do not un-ready Q-001 /
Q-014 / Q-003. Do not revive A-006.
