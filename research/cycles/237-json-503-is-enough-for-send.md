# Cycle 237 — JSON 503 is enough; SSE-shaped 503 would not change `send()`

**Date:** 2026-09-12T06:42:00Z
**Question:** Cycle 236: HTTP 503 does not poison
`sessionId`. A-019 503 body is JSON
(`runScheduledChats` L13032). SDK `send()` for `tools/call`
sets `Accept: application/json, text/event-stream` and on
`!ok` `text()`s then throws. Is that JSON 503 enough, or
would an SSE-shaped 503 change anything in this tree?
**Answer:** **JSON 503 is enough.** `send()` inspects
`Content-Type` only **after** `response.ok` (L384–390). On
`!ok` it `text()`s the body (L313) and throws
`StreamableHTTPError(status, …)` (L364). An SSE-shaped 503
would still be `!ok`, never reach `_handleSseStream`, and
only change the error string. GET 503 is the other face:
`_startOrAuthSse` **cancels** the body and throws on any
non-405 (L94–105) — that is why A-019 405s GET, not 503
(cycle 212). Copy `res.status(503).json({ message: 'Instance
draining — retry on new instance' })`. Do not emit
`text/event-stream` 503. Do not add `Retry-After`. Do not
add A-021.

## Evidence

### POST `send()` never parses SSE on `!ok`

```297:364:backend/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js
            headers.set('content-type', 'application/json');
            headers.set('accept', 'application/json, text/event-stream');
            // ...
            const response = await (this._fetch ?? fetch)(this._url, init);
            if (!response.ok) {
                const text = await response.text().catch(() => null);
                if (response.status === 401 && this._authProvider) { /* recurse send() */ }
                if (response.status === 403 && this._authProvider) { /* insufficient_scope */ }
                throw new StreamableHTTPError(response.status, `Error POSTing to endpoint: ${text}`);
            }
```

`StreamableHTTPError` stores `this.code = code` (L12–16) —
**503**, not the body. `text` is only the message suffix.
`res.status(503).json({ message: 'Instance draining — retry
on new instance' })` becomes that suffix. An SSE body would
be a worse suffix, same throw.

Content-type branching is **after** ok:

```384:390:backend/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js
            const contentType = response.headers.get('content-type');
            if (hasRequests) {
                if (contentType?.includes('text/event-stream')) {
                    this._handleSseStream(response.body, { onresumptiontoken }, false);
```

A 200 SSE JSON-RPC `isError` is the drain face cycle 211
rejected (HTTP 200; Q-001 fixture asserts 200). SSE 503
cannot sneak into `_handleSseStream` because 503 is not ok.

`DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS` `maxRetries: 2`
(L6–10) is GET SSE reconnect (`_scheduleReconnection`), not
POST `!ok`. Cycle 219: POST `_handleSseStream(..., false)` is
not reconnectable.

### GET is already the 405 exception

```94:105:backend/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js
            if (!response.ok) {
                await response.body?.cancel();
                if (response.status === 405) {
                    return;
                }
                throw new StreamableHTTPError(response.status, `Failed to open SSE stream: ${response.statusText}`);
            }
```

GET 503 throws **without** reading the body. JSON vs SSE
shape is irrelevant there. Keep 405.

### Q-001 fixture is status, then `data:`

`hermes-oauth-client.py` L84 `assert r.status_code == 200`
then `next(data:)`. A JSON 503 fails the assert and never
parses SSE. `HERMES_MCP_OAUTH.md` has zero content-type
pin. This tree’s `.platform` nginx has **zero** `error_page`
/ `proxy_intercept_errors` (timeouts + buffers only).

Hermes / Oh My Pi: host MCP clients already treat HTTP status
as the transport face. AgentWeb’s cutting-edge SDLC is the
same JSON 503 `runScheduledChats` already emits — one
admission bit, two routes — not an SSE drain envelope and
not a fifth `listen()`.

## First-slice correction (A-019 stays ready)

Keep `res.status(503).json({ message: 'Instance draining — retry
on new instance' })` like L13032. Add:

- Do **not** emit `Content-Type: text/event-stream` on drain
  503 (would not reach `_handleSseStream`; would only change
  the throw string).
- Do **not** add `Retry-After` (cycle 235: no in-repo client
  retries POST `/mcp` 503).
- Do **not** 503 GET `/mcp` (cycle 212).

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: this tree’s `.platform` has zero `error_page`
/ `proxy_intercept_errors`. Can unvendored platform nginx
still rewrite a JSON 503 into HTML/502 before Hermes sees it
(cycle 119: cannot name that nginx.conf)? Do not add
`error_page` (cycle 107). Do not add A-021. Do not un-ready
Q-001 / Q-014 / Q-003. Do not revive A-006. Do not mint a
timer unless Kevin asks.
