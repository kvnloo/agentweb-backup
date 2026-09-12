# Cycle 217 — `mcpShutdown` is not `generate_image` cancel

**Date:** 2026-09-12T04:38:00Z
**Question:** Cycle 216: `Protocol._onclose`
(`protocol.js` L245–257) does **not**
abort `_requestHandlerAbortControllers`
(set at L302–303). `transport.close()`
during in-flight hangs JSON
`handleRequest` without firing CallTool
`extra.signal`. File-level only: does
`mcpShutdown` ever cancel Q-014
`generate_image`, or is the A-019
wait the only billed hop?

**Answer:** **The wait is the billed
hop. `mcpShutdown` never cancels
`generate_image`.** `_onclose` does
not abort those controllers. The
only abort is a client
`notifications/cancelled`
(`_oncancel` L169–175). AgentWeb’s
CallTool handler ignores `extra`
entirely. `mcpFetch`’s
`AbortController` is a **timeout
timer**, not MCP close. The leaf
has no `AbortSignal`. Loopback
`POST /generate-image` is a
different socket from inbound
`/mcp`. Do not wire `extra.signal`
in A-019. Do not add A-021.

## Evidence

SDK abort is a **cancelled
notification**, not transport close:

```27:28:backend/node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js
        this.setNotificationHandler(CancelledNotificationSchema, notification => {
            this._oncancel(notification);
```

```169:175:backend/node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js
    async _oncancel(notification) {
        if (!notification.params.requestId) {
            return;
        }
        const controller = this._requestHandlerAbortControllers.get(notification.params.requestId);
        controller?.abort(notification.params.reason);
    }
```

`_onclose` (L245–257) drops
`_transport` and rejects **outbound**
`_responseHandlers`. It does not
iterate `_requestHandlerAbortControllers`.
`backend/src` and the Q-001 fixture
have **zero** `notifications/cancelled`
hits.

Even a fired `extra.signal` would
miss AgentWeb. CallTool is:

```88:89:backend/src/mcp/server/mcpServerCore.ts
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
```

No `extra`. `mcp/server/` greps of
`extra.signal` / `AbortSignal` are
empty. Protocol only **skips send**
after the handler returns if aborted
(L351–354). The billed
`mcpToolRegistry.execute` already
ran.

`generate_image` mcpFetch has no
`timeoutMs` and no signal
(`apiTools.ts` L2096–2108).
`McpFetchOptions` has `timeoutMs`
only (`httpClient.ts` L49). The
`AbortController` at L204–208 is
`setTimeout(() => controller.abort(),
effectiveTimeout)` — default 5 min.
It is not linked to MCP
`extra.signal` or `mcpShutdown`.

The REST leaf does not listen:

```174:187:backend/src/routes/emmaApi.ts
router.post('/generate-image', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    // ...
    const result = await svc.generateImage(
```

Contrast `/generate`
(`agentModeController.ts` L9098–9104
`req.on('close')` → `requestCancel`).
`imageGeneration.ts` has zero
`AbortSignal`. Cycle 79: mcpFetch
abort does not cancel the leaf or
skip the meter.

`mcpShutdown` is
`shutdownAllSessions`
(`mcpServer.ts` L245–257):
`transport.close()` on the **local
Map** only. Rehydrate is not on that
Map (cycle 215). Closing the MCP
SSE/JSON face does not abort
loopback `localhost:${PORT}`
(cycle 106). After local `close()`,
`_streamMapping` is empty;
`send()` of the completed CallTool
result then throws `No connection
established` (L672–694) — that is
a dropped reply, not a cancelled
vendor call.

A-019 first_slice: wait on
`track('mcpCallTool')`, **then**
`mcpShutdown` to end GET SSE / local
POST. Do **not** treat that close as
cancel. Do **not** wire `extra.signal`
through mcpFetch → `emmaApi` →
`generateImage` in this PR (cycle 79
hole; occupied `agentModeService.ts`).
Do not add HTTP.

## First-slice correction (A-019 stays ready)

1–4 unchanged. Add:

- Do **not** abort CallTool
  `extra.signal` from `mcpShutdown`.
  `_onclose` does not abort;
  the handler does not take `extra`.
- Do **not** treat `mcpShutdown` as
  `generate_image` cancel. The wait
  is the billed hop.
- Keep `finally close()` after
  resolved JSON (cycle 216).

Do not edit `slack.ts`. Do not add HTTP.
Do not add A-021.

## Relation to A-002 / A-007 / A-008

A-019 is still the architecture item
after #2+#3. This cycle only proves
close ≠ cancel. Not A-006. Q-001 /
Q-014 / Q-003 stay ready.

## Next cycle candidate

After local `close()` mid-CallTool,
`_onclose` does not set aborted, so
Protocol still `send()`s. `close()`
clears `_streamMapping` but not
`_requestToStreamMapping`, so
`send()` throws `No connection
established` (L672–694). File-level
only: is that throw inside Protocol
(Hermes sees hang/reset) or does
`mcpServerCore` catch it as
`isError` **after** the leaf billed?
Do not add A-021. Do not un-ready
Q-001 / Q-014 / Q-003. Do not
revive A-006.
