# Cycle 235 — A-019 POST `/mcp` 503 is a one-shot in this tree

**Date:** 2026-09-12T06:36:00Z
**Question:** Cycle 234: Hermes can see A-019 503 while
`/health` stays 200. Agent-engine retries `/run-scheduled-chats`
503 on its next 5s poll (`task_monitor.py` L1811 / comment
`agentModeController.ts` L13029–13030). Does any in-repo
Hermes / MCP SDK client retry POST `/mcp` HTTP 503 onto the
**new** instance, or is A-019 503 a one-shot fail for that
CallTool?
**Answer:** **One-shot for that POST.** No in-repo client
retries inbound `/mcp` HTTP 503 onto another instance. The
Q-001 fixture is httpx `assert status_code == 200` (L84).
Vendored `StreamableHTTPClientTransport.send()` throws
`StreamableHTTPError(status)` on `!response.ok` (L312–364);
the only `send()` recurse is 401+auth. `mcpClientService`
retries only `playwright_` / `browser_` tools (`maxAttempts`
1 otherwise, L1630) and `isConnectionError` does not match
503 (L178–189). That client is AgentWeb → vendor MCP, and
file-config already skips `agentweb-tools` (`mcpClientService.ts`
L420–432). `httpClient` mcpFetch never retries POST (L110–118).
Do not copy `3600000`. Do not add a 503 retry in A-019. Do
not add A-021.

## Evidence

### Q-001 fixture never retries

```81:86:backend/src/__tests__/e2e/fixtures/hermes-oauth-client.py
        async def rpc(method, params, id):
            r = await client.post(base + '/mcp', headers=headers,
                json={'jsonrpc': '2.0', 'id': id, 'method': method, 'params': params})
            assert r.status_code == 200
            import json
            return json.loads(next(line[6:] for line in r.text.splitlines() if line.startswith('data: ')))
```

`HERMES_MCP_OAUTH.md` has zero `503` / retry. `--connect-timeout
315` is OAuth add/login (cycle 220), not CallTool. Live Hermes
retry policy is not in this tree.

### SDK POST 503 is a throw, not a replay

```312:364:backend/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js
            if (!response.ok) {
                const text = await response.text().catch(() => null);
                if (response.status === 401 && this._authProvider) {
                    // ... auth then return this.send(message);
                }
                throw new StreamableHTTPError(response.status, `Error POSTing to endpoint: ${text}`);
            }
```

Cycle 219: POST `_handleSseStream(..., false)` is not
reconnectable. `protocol.js` has zero `retry` /
`StreamableHTTPError`. A 503 does not re-POST.

### AgentWeb-as-client is the other direction

`mcpClientService.ts` L1630: `generate_image` is not a
browser tool → **one** `callTool`. `isConnectionError` matches
timeout / hang-up / ECONNRESET / ECONNREFUSED / etimedout /
SSE disconnected / transport closed / aborted — not
`StreamableHTTPError(503)` / `Error POSTing`. Evict-on-connection
therefore does not fire for A-019 503 even if a Dynamo
`mcp_servers` row pointed at this `/mcp` (A-018 park).
File-config `isInternal` skip still holds (L420–432).

mcpFetch POST to `/api/emma/generate-image` is loopback on
**this** listen and is not retried (L115–118). A-019 503 is
**before** execute, so that hop does not start.

### The 5s retry is scheduled chats, not MCP

`task_monitor.py` L1811 `INTERVAL = 5` then L1818
`process_schedules()` → one `requests.post` of
`/run-scheduled-chats` (L316–320). Non-200 is logged (L339–340),
not retried inside the call. The next loop is a **new** POST
that ALB can send to the new instance. That is the comment at
`runScheduledChats` L13029–13030. Hermes has no equivalent
poller in this repo.

`toolErrorClassifier` would label a *string* `503 Service
Unavailable` as `upstream_5xx` (test L138) and tell **in-app
Emma** to retry once. That is not an HTTP replay of Hermes
`tools/call`, and it does not run unless the error reached
Agent Mode’s tool loop.

Hermes / Oh My Pi: the host retries if *its* loop decides to
call the tool again. AgentWeb’s cutting-edge SDLC is HTTP 503
as the drain face (cycle 211: not JSON-RPC `isError`) plus
ENG-114 rehydrate on a **later** POST to the new instance — not
a nanoservice mesh that retries the billed hop. Do not add
that retry in A-019 (would double-bill if the first POST had
already started; A-019 refuses before execute so a client retry
would be safe *if the client had one* — it does not).

## First-slice correction (A-019 stays ready)

Keep HTTP 503 on `method === 'tools/call'`. Add:

- Do **not** add an inbound 503 retry / `Retry-After` in A-019
  (no in-repo Hermes client would use it; Q-001 fixture
  asserts 200).
- Do **not** copy `mcpClientService` browser retry or 3600000
  onto inbound CallTool.
- Do **not** retry mcpFetch POST from this PR.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: after HTTP 503, does the vendored client keep
`transport.sessionId` so a **later** Hermes `tools/call` (user
retry / next turn) can hit the new instance and rehydrate
(ENG-114), or does 503 poison the session? `send()` sets
`_sessionId` from the response header before the `!ok` throw
(L308–310). Do not `sessions.clear()` on the 503 path. Do not
add A-021. Do not un-ready Q-001 / Q-014 / Q-003. Do not
revive A-006. Do not mint a timer unless Kevin asks.
