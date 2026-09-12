# Cycle 215 — rehydrate CallTool is the wrap, not `mcpShutdown`

**Date:** 2026-09-12T04:25:00Z
**Question:** Cycle 214: JSON-mode
`cleanup` does not `resolveJson`
(`webStandardStreamableHttp.js`
L458–460). Rehydrate transports are
not on the local Map. If a rehydrate
CallTool is still in
`track('mcpCallTool')` at drain
ceiling, does wrapping the handler
already cover it, or can that Promise
outlive `mcpShutdown`?

**Answer:** **The wrap covers it.
`mcpShutdown` must not see that
transport.** Rehydrate is created,
served, and `close()`d in `finally`
(`mcpSessionRehydration.ts` L15–18 /
L115–118). It never
`sessions.set`s. JSON `close()` during
an in-flight CallTool would **hang**
`handleRequest` (cleanup deletes the
map entry and never calls
`resolveJson`). Putting it on the
local Map to “help” drain is the bug.
Do not add A-021.

## Evidence

Both POST faces share one handler.
Local hit reuses the Map transport
(`mcpServer.ts` L307–313). Cross-
instance miss calls `rehydrateAndServe`
(L439–441) which builds a **new**
`WebStandardStreamableHTTPServerTransport`
with `enableJsonResponse: true` and
the production factory
`createMcpServer` (L86–96) — same
`CallToolRequestSchema` at
`mcpServerCore.ts` L88–120. Cycle 70:
wrap that once; do not wrap only
rehydrate.

Rehydrate is request-scoped. Comment
and `finally` are the contract:

```15:18:backend/src/mcp/server/mcpSessionRehydration.ts
 * JSON-response mode keeps every exchange a finite
 * request/response (no lingering SSE stream), so the transport is created, used,
 * and closed within the request — keeping memory strictly bounded (one transport
 * per in-flight rehydrated request, never cached/accumulated).
```

```115:118:backend/src/mcp/server/mcpSessionRehydration.ts
  } finally {
    await transport.close().catch(() => {
      /* best-effort teardown — the request response is already sent */
    });
```

JSON-mode `handleRequest` is a Promise
that resolves only via `resolveJson`
when the MCP result is ready
(`webStandardStreamableHttp.js`
L453–470 / L696–706). The `cleanup`
stored on that stream (L458–460) is
**delete only**. `close()` L604–613
`forEach(cleanup)` therefore drops the
resolver without firing it. A
`mcpShutdown` that closed this object
mid-`generate_image` would leave
`await transport.handleRequest` hung
until force-exit — worse than leaving
the Express POST up for
`server.close` to wait on.

`mcpShutdown` cannot do that today:
`sessions.set` is only initialize
(`mcpServer.ts` L338). GET L516 is
local-Map only (cycle 212). Rehydrate
never joins that Map. At drain
ceiling, `cronJobRegistry.drain()`
returns `drained: false` with the
stuck `mcpCallTool` still in
`inFlight` (`cronJobRegistry.ts`
L68–73). `mcpShutdown` then closes
**GET SSE / local POST** only. The
rehydrate Express socket is finite
JSON; `server.close` waits on it the
same way cycle 70 said. Force-exit is
`DRAIN_CEILING_MS + 3 min`
(`server.ts` L379–382).

A-019 step 1 already 503s POST
`tools/call` at L298 **before** the
`sessions.has` / rehydrate branch. New
cross-instance CallTools never prime.
In-flight ones (started before
`disableCron`) are the wrap. Do not
`sessions.set` the rehydrate
transport. Do not set
`enableJsonResponse` on the live
local transport (cycle 214). Tests
(`mcpSessionRehydration.test.ts`
L99–113) pin tools/call 200, not
`close()`.

## First-slice correction (A-019 stays ready)

1–4 unchanged. Add:

- Wrap `CallTool` in `mcpServerCore`
  (covers local **and** rehydrate).
- Do **not** `sessions.set` a rehydrate
  transport. JSON `close()` does not
  `resolveJson`.
- Do **not** wrap only
  `rehydrateAndServe`.

Do not edit `slack.ts`. Do not add HTTP.
Do not add A-021.

## Relation to A-002 / A-007 / A-008

A-019 is still the architecture item after
#2+#3. This cycle only proves the JSON
hole is why rehydrate stays off the Map.
Not A-006. Q-001 / Q-014 / Q-003 stay ready.

## Next cycle candidate

`resolveJson` (L706) does not call
`stream.cleanup()` (SSE else L712–714
does). Mapping stays until `finally`
`close()`. File-level only: is that
`finally` load-bearing for memory, or
does a skipped `close()` after a
resolved JSON CallTool still leak the
WebStandard transport? Do not add
A-021. Do not un-ready Q-001 / Q-014 /
Q-003. Do not revive A-006.
