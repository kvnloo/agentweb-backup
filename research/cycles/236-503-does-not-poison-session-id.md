# Cycle 236 — HTTP 503 does not poison `transport.sessionId`

**Date:** 2026-09-12T06:40:00Z
**Question:** Cycle 235: A-019 POST `/mcp` 503 is a one-shot
in this tree. After that throw, does the vendored client keep
`transport.sessionId` so a **later** Hermes `tools/call`
(user retry / next turn) can hit the new instance and
rehydrate (ENG-114), or does 503 poison the session?
**Answer:** **503 does not clear `sessionId`.**
`send()` copies `mcp-session-id` from the response header
before the `!ok` throw (L308–310). A drain 503 will not send
that header, so the initialize-time `_sessionId` stays.
Only `terminateSession()` sets `_sessionId = undefined`
(L450). `Client.connect()` skips `initialize` when
`transport.sessionId` is set (L287–288). A later POST keeps
the same `Mcp-Session-Id`. On the **new** instance that is
ENG-114 `rehydrateAndServe` if the store still has the row
(`mcpServer.ts` L396–445). A-019 503 is before the session
branches (L298) and must not `sessions.clear()` or
`sessionStore.delete` (cycle 94: only DELETE `/mcp` L565 /
L583 deletes). Default store is **memory** (cycle 95); then
the new instance 404s and the client must initialize again —
that is the existing cross-instance miss, not a 503 poison.
Do not 404 instead of 503 hoping for ENG-97 auto-reinit
(cycle 219: `send()` throws `StreamableHTTPError` for 404
too). Do not add A-021.

## Evidence

### Client keeps the id

```306:364:backend/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js
            const response = await (this._fetch ?? fetch)(this._url, init);
            const sessionId = response.headers.get('mcp-session-id');
            if (sessionId) {
                this._sessionId = sessionId;
            }
            if (!response.ok) {
                // 401 + auth → return this.send(message)
                throw new StreamableHTTPError(response.status, `Error POSTing to endpoint: ${text}`);
            }
```

`if (sessionId)` is truthy-header only. A-019 `res.status(503)`
like `runScheduledChats` L13032 has no `mcp-session-id`.
Existing `_sessionId` from initialize remains. `close()`
(L280–286) aborts and `onclose`s; it does not appear in the
`!ok` path. `terminateSession` (DELETE) is the clearer.

```283:288:backend/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js
    async connect(transport, options) {
        await super.connect(transport);
        if (transport.sessionId !== undefined) {
            return;
        }
```

A later `callTool` therefore POSTs with the old header.

### Server: 503 must not evict the row

A-019 inserts at POST `/mcp` L298, **before**
`sessions.has` / initialize / rehydrate. `shutdownAllSessions`
`sessions.clear()` is local-Map only and still must not
`sessionStore.delete` (cycle 94). DELETE `/mcp` stays ungated
(cycle 211). Initialize during drain still `sessionStore.set`
(L354–359) so a *new* session on the dying instance can
rehydrate on the next.

New-instance path for the **same** id: L396–445
`sessionStore.get` → `rehydrateAndServe`. Factory default
`createMcpSessionStore` is memory unless
`MCP_SESSION_STORE=dynamo` (L205–210). Cycle 95: unset in this
tree. Memory-new-instance is a genuine miss → 404 L448–460,
same as any Immutable swap without Dynamo — not caused by
503.

### 503 is not the ENG-97 404 face

`mcp.mcpServer.test.ts` L243–249 / L263–281 documents 404 →
reinit as a **three-step** client walk with mocked transport.
Cycle 219: live `send()` does not special-case 404; it throws
`StreamableHTTPError(status)`. Returning 404 for drain would
not auto-heal and would look like session expiry (Q-014
`generate_image` would look unlisted after a new initialize
if Hermes cached `tools/list` — cycle 211). Keep HTTP 503.

Hermes / Oh My Pi: one process, no rehydrate. AgentWeb’s
cutting-edge SDLC is drain 503 on the old listen plus ENG-114
rehydrate of the **same** session on the new listen when the
store is shared — not a fifth `listen()` and not 404-as-drain.

## First-slice correction (A-019 stays ready)

Keep 503 at L298 before session branches. Add:

- Do **not** `sessions.clear()` or `sessionStore.delete` on
  the 503 path.
- Do **not** 404 drain `tools/call` (ENG-97 face is unknown
  session, not drain).
- Do **not** flip `MCP_SESSION_STORE` from A-019 (cycle 95).

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: A-019 503 body is JSON
(`runScheduledChats` L13032). SDK `send()` for `tools/call`
sets `Accept: application/json, text/event-stream` and on
`!ok` `response.text()`s (L313) then throws — it does not
require SSE. Is a JSON 503 enough, or would an SSE-shaped 503
change anything in this tree? Do not add `Retry-After`. Do
not add A-021. Do not un-ready Q-001 / Q-014 / Q-003. Do not
revive A-006. Do not mint a timer unless Kevin asks.
