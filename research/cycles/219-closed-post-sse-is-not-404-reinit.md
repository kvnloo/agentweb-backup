# Cycle 219 — closed POST SSE is not 404 reinit

**Date:** 2026-09-12T04:52:00Z
**Question:** Cycle 218: if `close()` mid-CallTool,
`send()` throws and `_onerror` logs.
File-level only: does the vendored
Streamable HTTP **client** treat a
closed POST SSE as retry/reinit
(404) vs terminal, and does the
Q-001 fixture ever see that?

**Answer:** **Neither 404 nor POST-SSE
resume. The in-flight CallTool is
already HTTP 200 SSE. `close()`
ends that stream with no JSON-RPC
result. The vendored client does
not reconnect that POST. 404
reinit is a later POST after
`sessions.clear()`.** The Q-001
fixture never GET, never retries
initialize on a failed `tools/call`,
and would `StopIteration` on empty
`data:` lines. Do not treat ENG-97
404 as covering a billed image
whose POST already returned 200.

## Evidence

SDK `send()` POST path (v1.25.2)
opens SSE with **`isReconnectable:
false`**:

```385:390:backend/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js
            if (hasRequests) {
                if (contentType?.includes('text/event-stream')) {
                    this._handleSseStream(response.body, { onresumptiontoken }, false);
```

Reconnect requires
`canResume && !receivedResponse`
(`L221–228` / `L237–239`):

```
canResume = isReconnectable || hasPrimingEvent
```

POST: `isReconnectable` is false.
`hasPrimingEvent` is only set when
an SSE event has `id` (L190–193).
Priming is **opt-in eventStore**
and protocol `>= 2025-11-25`:

```157:160:backend/node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js
    async writePrimingEvent(controller, encoder, streamId, protocolVersion) {
        if (!this._eventStore) {
            return;
        }
```

`backend/src/mcp/` has **zero**
`eventStore`. Local initialize
(`mcpServer.ts` L333) only passes
`sessionIdGenerator` +
`onsessioninitialized`. Q-001
fixture initialize is
`2025-06-18` (`hermes-oauth-client.py`
L76) — priming would skip even
with a store.

So `close()` mid-CallTool: reader
`done` or throws `SSE stream
disconnected`; `receivedResponse`
stays false; **no
`_scheduleReconnection`**. Protocol
`request()` then waits until
`DEFAULT_REQUEST_TIMEOUT_MSEC`
60000 (`protocol.js` L8) unless
the caller set another timeout.
That is a **timeout**, not 404.

404 is a **different HTTP
request**. `shutdownAllSessions`
`close()`s then `sessions.clear()`
(`mcpServer.ts` L245–257). The
in-flight POST already returned
200 (`handlePostRequest` L535).
The **next** POST with the old
`mcp-session-id` hits L448–460
JSON 404 `-32001`. Tests pin that
HTTP shape (`mcp.mcpServer.test.ts`
L243–249 / L263–318) and **mock**
the transport; they do not run
`StreamableHTTPClientTransport`.
This SDK `send()` on `!response.ok`
throws `StreamableHTTPError(status)`
(L364) with **no** 404-special
reinit. Client `connect()` skips
initialize when
`transport.sessionId` is already
set (`client/index.js` L285–288).

Q-001 fixture is **httpx**, not
that class:

```73:86:backend/src/__tests__/e2e/fixtures/hermes-oauth-client.py
    headers = {'Accept': 'application/json, text/event-stream'}
    async with httpx.AsyncClient(auth=provider, headers=headers) as client:
        response = await client.post(base + '/mcp', json={'jsonrpc': '2.0', 'id': 1,
            'method': 'initialize', ...
        async def rpc(method, params, id):
            r = await client.post(base + '/mcp', headers=headers, json=...)
            assert r.status_code == 200
            return json.loads(next(line[6:] for line in r.text.splitlines() if line.startswith('data: ')))
```

`tools/call` is `fixture_identity`,
not `generate_image`. Empty SSE:
`next(...)` raises. No GET. No
retry initialize. DELETE at L95
is the happy path.

## First-slice correction (A-019 stays ready)

Keep wait-then-`mcpShutdown` so
`send()` can usually complete
(cycle 218). Add:

- Do **not** treat ENG-97 404
  reinit as covering an in-flight
  CallTool whose POST already
  returned 200 SSE.
- Do **not** add `eventStore` in
  this PR to make POST resumable.
- Do **not** change Q-001 smoke
  to assert this drain race.

Do not wire `extra.signal`. Do not
add HTTP. Do not add A-021.

## Relation to A-002 / A-007 / A-008

A-019 is still the architecture item
after #2+#3. This cycle only proves
the closed POST SSE is not the 404
face. Not A-006. Q-001 / Q-014 /
Q-003 stay ready.

## Next cycle candidate

If `close()` wins, Protocol
`DEFAULT_REQUEST_TIMEOUT_MSEC` is
60s (`protocol.js` L8) while Q-014
mcpFetch default is 5 min and the
leaf is 8 min. File-level only:
does inbound Hermes inherit that
60s, or is timeout only AgentWeb
as MCP *client* (`mcpClientService`
3600000)? Do not add A-021. Do not
un-ready Q-001 / Q-014 / Q-003.
Do not revive A-006.
