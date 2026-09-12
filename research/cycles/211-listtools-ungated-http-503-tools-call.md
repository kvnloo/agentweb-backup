# Cycle 211 — do not drain-gate ListTools; HTTP 503 `tools/call`

**Date:** 2026-09-12T03:55:00Z
**Question:** Cycle 210 put A-019 refuse at
the CallTool handler as JSON-RPC
`isError`. Should drain also gate
`ListTools` / `initialize` / all POST
`/mcp`, or only CallTool + `/generate`
503?

**Answer:** Only **HTTP 503** when the POST
`/mcp` body contains `tools/call`, plus
the existing `/generate` 503. Do **not**
gate ListTools or initialize. JSON-RPC
`isError` is the wrong face — Hermes
treats HTTP status, not tool-error
text, as the transport signal.

## Evidence

`mcp/server/` still has **zero**
`isCronEnabled` / `disableCron` /
`draining` hits. The only
`cronJobRegistry` import under `mcp/`
is the OAuth refresh client
(`mcpOAuthRefreshService.ts` L89), not
the inbound server. POST `/mcp` logs
`req.body?.method` and never checks
drain:

```296:302:backend/src/mcp/server/mcpServer.ts
  // POST handler - handles all JSON-RPC messages including initialization
  app.post("/mcp", express.json(), validateMcpAccessToken, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    console.log(`[MCP-SERVER-DEBUG] POST request - sessionId header: ${sessionId || 'MISSING'}, method: ${req.body?.method || 'unknown'}, has session: ${sessionId ? sessions.has(sessionId) : 'N/A'}`);
```

ListTools is ungated `getToolDefinitions()`
with no skill gate (Q-014’s face after
kvnloo#2 includes `generate_image`):

```81:84:backend/src/mcp/server/mcpServerCore.ts
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const allTools = mcpToolRegistry.getToolDefinitions();
    return { tools: allTools };
  });
```

initialize during drain still
`sessions.set` and best-effort Dynamo
persist (ENG-114). That is **useful**
under no sticky routing: a Hermes retry
of `tools/call` with the same
`mcp-session-id` can land on the new
instance and `rehydrateAndServe`, whose
production factory is `createMcpServer`:

```316:359:backend/src/mcp/server/mcpServer.ts
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // ...
            sessions.set(newSessionId, {
              transport,
              lastActivity: Date.now(),
              agentUserId: sharedState.agentUserId,
              // ...
            });
            void sessionStore
              .set({
                sessionId: newSessionId,
                agentUserId: sharedState.agentUserId,
                isInternal: sharedState.isInternal,
              })
```

```81:86:backend/src/mcp/server/mcpSessionRehydration.ts
  // Default (production) factory. The real createMcpServer signature is
  // (serverName, context); adapt it to the single-arg ServerFactory shape.
  createServer: ServerFactory = (context) => createMcpServer(MCP_SERVER_NAME, context),
```

Anonymous discovery already permits
`initialize` + `tools/list` with no
auth. 503ing those during Sunday recycle
flakes ENG-984; shrinking ListTools
looks like Q-014 rolled back and Hermes
caches `tools/list`:

```41:45:backend/src/mcp/server/anonymousTransport.ts
const ANONYMOUS_METHODS: ReadonlySet<string> = new Set([
  'initialize',
  'notifications/initialized',
  'ping',
  'tools/list',
]);
```

The batch shape to copy is already
here — `req.body?.method` is **wrong**
for a JSON-RPC array (L302 logs
`unknown`). Fail closed if **any**
entry is `tools/call`:

```68:83:backend/src/mcp/server/anonymousTransport.ts
export function isAnonymouslyPermitted(body: unknown): boolean {
  const entries = Array.isArray(body) ? body : [body];
  if (entries.length === 0) return false;

  return entries.every(entry => {
    // ...
    if (method === 'tools/call') {
      const name = (entry as { params?: { name?: unknown } }).params?.name;
      return typeof name === 'string' && ANONYMOUS_TOOLS.has(name);
    }
    return ANONYMOUS_METHODS.has(method);
  });
}
```

HTTP status is the SDK face, not
CallTool `isError` (HTTP 200 +
`isError: true` at `mcpServerCore.ts`
L164–173). The existing POST `/mcp`
test documents 404 → auto-reinit vs
400 terminal:

```243:249:backend/src/__tests__/mcp.mcpServer.test.ts
    it('should return 404 for stale/unknown session ID (so MCP client auto-reinitializes)', async () => {
      // ... The MCP TypeScript SDK's StreamableHTTPClientTransport treats 404 as "session expired"
      // and automatically re-initializes a new session ...
      // Returning 400 (the prior behavior) was treated as terminal by the SDK ...
```

Q-001’s Hermes fixture asserts **200**
on both list and call. Drain `isError`
would still be 200 (model sees a tool
failure, retries the **same** session —
cycle 105). HTTP 503 matches
`runScheduledChats` (agent-engine retries
onto the new instance) and clusters as
retryable `upstream_5xx` if anything
inside AgentWeb classifies it:

```81:88:backend/src/__tests__/e2e/fixtures/hermes-oauth-client.py
        async def rpc(method, params, id):
            r = await client.post(base + '/mcp', headers=headers,
                json={'jsonrpc': '2.0', 'id': id, 'method': method, 'params': params})
            assert r.status_code == 200
```

```13029:13032:backend/src/controllers/agentModeController.ts
    if (!isCronEnabled()) {
      return res.status(503).json({ message: 'Instance draining — retry on new instance' });
    }
```

```87:87:backend/src/utils/toolErrorClassifier.ts
  if (status >= 500) return 'upstream_5xx';
```

Q-014 `generate_image` is mcpFetch
`/api/emma/generate-image`, not POST
`/mcp`. Internal Emma does not use MCP
for this tool (cycle 26). HTTP 503 on
`tools/call` stops the **Hermes** billed
hop; it does **not** block loopback
image hops. CallTool still needs
`track('mcpCallTool')` so in-flight
calls that passed admission wait out
`runDrain`. Do **not** wrap
`registry.execute` (tests call it
directly). `createMcpServer` comment
still says stdio+HTTP; live inbound is
`/mcp` only (cycle 91). Putting drain
`isError` in the handler would fire in
`createMcpServer` unit tests.

GET `/mcp` SSE (L508–531) is still
ungated, `res.setTimeout(0)`. Not billed.
Next candidate — do not fold it into
this slice. Do not 503 DELETE `/mcp`
(owner terminate still evicts ENG-114).

`gracefulShutdown.test.ts` still has
**zero** `mcpServer` / `mcpServerCore`
hits. Copy the chatbotTurn source-scan
(L249–255). Optional drain case on the
existing POST `tools/call` at
`mcp.mcpServer.test.ts` L293
(initialize still 200; list still 200;
call 503).

## First-slice correction (A-019 stays ready)

After kvnloo#2, not instead of Q-014:

1. **POST `/mcp`** (`mcpServer.ts` L298):
   `if (!isCronEnabled())` and body
   contains `tools/call` → HTTP 503 like
   L13031. Copy anonymousTransport
   batch fail-closed. Do **not** 503
   initialize, `tools/list`, `ping`,
   `notifications/initialized`, or
   DELETE.
2. **CallTool handler:**
   `track('mcpCallTool', …)` around
   execute for the **wait** only. Do
   **not** return drain `isError`. Do
   not wrap `registry.execute`.
3. **`generateResponse`:** 503 before
   `tryClaim`. `tryClaim` stays busy-only.
   Auto-continuation L1350: skip if
   `!isCronEnabled`.
4. Do not refuse inside `track()`. Do
   not hide `generate_image` from
   ListTools. Do not edit `slack.ts`
   (#2393). Do not add HTTP. Do not add
   A-021.

AgentWebPro 2026-09-12 still empty on
`mcpServer.ts` / `mcpServerCore.ts` /
`cronJobRegistry.ts` / `instanceState.ts`
/ `apiTools.ts`.

## Relation to A-002 / A-007 / A-008

A-019 is still the architecture item after
#2+#3. This cycle only moves admission
from CallTool `isError` to POST `/mcp`
503. Not A-006. Q-001 / Q-014 / Q-003
stay ready.

## Next cycle candidate

GET `/mcp` SSE (`mcpServer.ts` L508–531)
has no drain check and timeout 0. New
SSE during overlap pins Hermes
notifications to the dying box; it is
not billed. File-level only if A-019
should 503 **new** GET. Do not add
A-021. Do not start another S3/Referer
matcher.
