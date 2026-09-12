# Cycle 220 — 60s is client `request()`, not inbound CallTool

**Date:** 2026-09-12T04:56:00Z
**Question:** Cycle 219: if `close()` wins,
Protocol `DEFAULT_REQUEST_TIMEOUT_MSEC`
is 60s (`protocol.js` L8) while Q-014
mcpFetch is 5 min and the leaf is 8 min.
File-level only: does inbound Hermes
inherit that 60s, or is timeout only
AgentWeb as MCP *client*
(`mcpClientService` 3600000)?

**Answer:** **The 60s is
`Protocol.request()` on whoever
issued `tools/call`. AgentWeb’s
inbound CallTool handler has none.
AgentWeb as MCP *client* overrides
to 1 hour. The Q-001 fixture never
uses `Protocol.request()`. Hermes
`--connect-timeout 315` is OAuth
add/login, not CallTool.** A default
SDK client calling Q-014
`generate_image` would abandon at
60s while mcpFetch+leaf still run
and bill (cycle 217). Do not copy
3600000 onto inbound. Do not add
A-021.

## Evidence

The constant is the **caller’s**
outbound wait:

```8:8:backend/node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js
export const DEFAULT_REQUEST_TIMEOUT_MSEC = 60000;
```

```691:693:backend/node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js
            const timeout = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
            const timeoutHandler = () => cancel(McpError.fromError(ErrorCode.RequestTimeout, 'Request timed out', { timeout }));
            this._setupTimeout(messageId, timeout, options?.maxTotalTimeout, timeoutHandler, options?.resetTimeoutOnProgress ?? false);
```

`Client.callTool` passes `options`
through (`client/index.js` L488–493).
Omit `timeout` → 60s, then
`notifications/cancelled` (L649–662)
which **does** abort extra.signal
(cycle 217) — AgentWeb’s handler
still ignores `extra`.

Inbound server handler
(`mcpServerCore.ts` L88–176) has
**zero** `timeout` /
`DEFAULT_REQUEST_TIMEOUT`. The billed
hop is mcpFetch default 5 min
(`httpClient.ts` L205) then leaf
8 min (`imageGeneration.ts` L78–79).

AgentWeb as **client** already
overrides:

```1667:1670:backend/src/mcp/client/mcpClientService.ts
                result = await sessionClient.callTool({
                  name: originalToolName, // Use ORIGINAL (unprefixed) name for execution
                  arguments: toolArgs
                }, undefined, { timeout: 3600000 }); // 1 hour timeout (effectively unlimited for this use case)
```

That is outbound vendor MCP, not
Hermes → Emma.

Q-001 fixture: httpx
`AsyncClient` (L74) with no
`timeout=`; `rpc()` asserts 200 and
parses `data:` (cycle 219). E2E
wrapper timeout is **20000** on
the Python process
(`hermes-oauth.e2e.test.ts` L71),
not CallTool. `tools/call` is
`fixture_identity`. Hermes runbook
315s is `hermes mcp add` /
callback wait
(`HERMES_MCP_OAUTH.md` L21–36).
Live Hermes `callTool` timeout is
**not in this tree**.

If `close()` does **not** win,
`send()` still has to beat the
**client’s** timer. Default SDK
60s < 5 min hop. Wait-then-close
cannot lengthen Hermes’ wait.

## First-slice correction (A-019 stays ready)

Keep wait-then-`mcpShutdown`. Add:

- Do **not** copy
  `mcpClientService` 3600000 onto
  inbound CallTool.
- Do **not** add a server-side 60s
  to “match” the SDK default (cuts
  Q-014).
- Q-001 smoke stays OAuth +
  `tools/list`. A later
  `generate_image` CallTool via
  default SDK `callTool()` may
  timeout at 60s while the leaf
  bills. That is operator timeout,
  not A-019 refuse.

Do not wire `extra.signal`. Do not
add HTTP. Do not add A-021.

## Relation to A-002 / A-007 / A-008

A-019 is still the architecture item
after #2+#3. This cycle only names
which side owns the 60s. Not A-006.
Q-001 / Q-014 / Q-003 stay ready.

## Next cycle candidate

`cancel()` on the 60s timer sends
`notifications/cancelled` (L649–662)
which aborts extra.signal. AgentWeb
ignores `extra`. File-level only:
does that notification arrive on
the **same** POST SSE already
waiting for `send()`, or a new
POST, and can it land after
`mcpShutdown` `close()`? Do not add
A-021. Do not un-ready Q-001 /
Q-014 / Q-003. Do not revive A-006.
