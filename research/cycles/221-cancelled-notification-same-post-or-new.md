# Cycle 221 — `notifications/cancelled` is a new POST, not the CallTool SSE

**Date:** 2026-09-12T05:05:00Z
**Question:** Cycle 220: `cancel()` on
the 60s timer sends
`notifications/cancelled`
(`protocol.js` L649–662) which
aborts `extra.signal`. AgentWeb
ignores `extra`. File-level only:
does that notification ride the
**same** POST SSE already waiting
for `send()`, or a new POST, and
can it land after `mcpShutdown`
`close()`?

**Answer:** **It is a new POST.
`relatedRequestId` is a
server-send option the client HTTP
transport ignores. After
`mcpShutdown` `sessions.clear()`,
that POST cannot abort the
original CallTool.** During the
A-019 wait the session is still in
the Map, so cancelled 202s on the
live Protocol and `_oncancel`
aborts `extra` — AgentWeb still
bills; Protocol then **skips
`send()`**. Do not 503 that
notification. Do not add A-021.

## Evidence

`cancel()` always `send()`s a
JSON-RPC **notification** (no
`id`):

```649:662:backend/node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js
            const cancel = (reason) => {
                this._responseHandlers.delete(messageId);
                this._progressHandlers.delete(messageId);
                this._cleanupTimeout(messageId);
                this._transport
                    ?.send({
                    jsonrpc: '2.0',
                    method: 'notifications/cancelled',
                    params: {
                        requestId: messageId,
                        reason: String(reason)
                    }
                }, { relatedRequestId, resumptionToken, onresumptiontoken })
                    .catch(error => this._onerror(new Error(`Failed to send cancellation: ${error}`)));
```

`relatedRequestId` here is the
**caller’s** `request()` option
(`protocol.js` L592). Top-level
`Client.callTool` passes `options`
through (`client/index.js`
L488–493) and does not set it.
`TransportSendOptions` documents
`relatedRequestId` as which
**incoming** request to associate
an **outgoing** message with
(`transport.d.ts` L22–24) — that
is the **server** writing onto the
CallTool SSE (`webStandardStreamableHttp.js`
L638–647). The client HTTP
transport never reads it:

```288:305:backend/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js
    async send(message, options) {
        try {
            const { resumptionToken, onresumptiontoken } = options || {};
            if (resumptionToken) {
                this._startOrAuthSse({ resumptionToken, replayMessageId: isJSONRPCRequest(message) ? message.id : undefined }).catch(err => this.onerror?.(err));
                return;
            }
            const headers = await this._commonHeaders();
            headers.set('content-type', 'application/json');
            headers.set('accept', 'application/json, text/event-stream');
            const init = {
                ...this._requestInit,
                method: 'POST',
                headers,
                body: JSON.stringify(message),
                signal: this._abortController?.signal
            };
            const response = await (this._fetch ?? fetch)(this._url, init);
```

HTTP POST cannot append to the
in-flight `tools/call` body. No
`resumptionToken` → always a
**second** POST. Notifications
have no `id`
(`types.js` L126–132 vs request
L115–121), so
`hasRequests` is false and the
server returns **202** after
`onmessage`:

```434:441:backend/node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js
            const hasRequests = messages.some(isJSONRPCRequest);
            if (!hasRequests) {
                for (const message of messages) {
                    this.onmessage?.(message, { authInfo: options?.authInfo, requestInfo });
                }
                return new Response(null, { status: 202 });
            }
```

That `onmessage` is Protocol
`_onnotification` → constructor
handler → `_oncancel`
(`protocol.js` L27–28 /
L169–175). Same live `Server`
only if `sessions.has` still
points at that transport
(`mcpServer.ts` L307–315 then
L491 `handleRequest`).

After `mcpShutdown`:
`transport.close()` then
`sessions.clear()` (`mcpServer.ts`
L245–257). **Does not**
`sessionStore.delete` (cycle 94).
The next cancelled POST is
therefore ENG-114 rehydrate — a
**new** `createMcpServer` with
empty `_requestHandlerAbortControllers`
— or 404 (`mcpServer.ts`
L448–460). `_onclose` still does
not abort the original map
(cycle 217). Rehydrate `finally
close()` cannot reach the
in-flight CallTool’s Protocol.

If cancelled **does** hit the
live Protocol (drain wait, before
`mcpShutdown`):

```351:355:backend/node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js
            if (abortController.signal.aborted) {
                // Request was cancelled
                return;
            }
```

AgentWeb CallTool is still
`async (request) =>`
(`mcpServerCore.ts` L88) — no
`extra`. mcpFetch+leaf still run
and bill (cycle 217). Protocol
then **skips `send()`**. That is
not `isError` and not cycle 218’s
post-close `_onerror`. Do not
treat it as A-019 refuse.

Anonymous cancelled is **not**
discovery. `ANONYMOUS_METHODS`
is initialize /
`notifications/initialized` /
ping / `tools/list`
(`anonymousTransport.ts` L41–46).
`mcpAnonymousTransport.test.ts`
L42–45 pins that list; cancelled
is absent. Flag on + no Bearer →
401 at `validateMcpAccessToken`
L61–72, never `_oncancel`. Q-001
is OAuth, so cancelled can 202.
Do not add it to
`ANONYMOUS_METHODS` in A-019.

`backend/src` and the Q-001
fixture still have **zero**
`notifications/cancelled` hits.
The fixture is httpx (cycle 219)
and never `Protocol.request()`.

## First-slice correction (A-019 stays ready)

Keep wait-then-`mcpShutdown`. Add:

- POST 503 must copy
  `anonymousTransport.ts` L77
  `method === 'tools/call'`, not
  “any POST while draining” and
  not `body` string-contains
  `tools/call`.
- Do **not** 503
  `notifications/cancelled` (or
  `notifications/initialized`,
  ping, `tools/list`, initialize,
  DELETE `/mcp`).
- Do **not** 503 cancelled in
  order to “stop extra.abort”
  — AgentWeb ignores `extra`;
  503 only makes the client’s
  fire-and-forget `send()` hit
  `StreamableHTTPError`.
- Do **not** wire `extra.signal`.
- Do **not** add
  `notifications/cancelled` to
  `ANONYMOUS_METHODS`.

Do not add HTTP. Do not add
A-021.

## Relation to A-002 / A-007 / A-008

A-019 is still the architecture
item after #2+#3. This cycle
only names the cancel hop as a
second POST. Not A-006.

## Next cycle

If cancelled 202s during the
wait, Protocol L351 skips
`send()` and the original POST
SSE never gets a JSON-RPC
result. File-level only: does
that leave `_requestToStreamMapping`
so `mcpShutdown` `close()` is
still the hang closer (cycle
214 GET vs this POST stream),
or does skip-send already
`stream.cleanup()`?
