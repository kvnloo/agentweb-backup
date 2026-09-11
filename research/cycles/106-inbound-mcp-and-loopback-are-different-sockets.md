# Cycle 106 — inbound `/mcp` and loopback mcpFetch are different sockets

**UTC:** 2026-09-11T22:40:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 105: listed `emma_send_message` POST is not retried after
`server.close`. Cycle 72: GET `/mcp` SSE holds a socket so close
never finishes. Does an inbound Hermes CallTool after close still
reach `execute()` on a keep-alive — or is that a different socket
from the loopback that fetch-fails?

## Finding

**They are different sockets, and this tree never closes idle
ones.** `runDrain` calls `server.close` only (`server.ts` L440).
Node 18.2+ `closeIdleConnections` / `closeAllConnections` are
typed in this repo (`@types/node/http.d.ts` L415–425) and have
**zero** production or test callers. `POST /mcp`
(`mcpServer.ts` L298) has no `isCronEnabled` / `listening` check
(`backend/src/mcp/` still zero of those strings).

### Two hops after close

| Hop | Socket | After `server.close()` |
|---|---|---|
| Q-001 Hermes → `https://api.agentweb.pro/mcp` | ALB → nginx `:80` → Node | New upstream TCP is refused. This tree’s `.platform/nginx` has **zero** `keepalive` (only `/socket.io/` names `127.0.0.1:8080`). Hermes sees a proxy/ALB error, not MCP `isError`. Platform default `nginx.conf` is not vendored — live keepalive unverified. |
| `emma_send_message` mcpFetch | `http://localhost:${PORT}` (`httpClient.ts` L94–96) | **Bypasses nginx.** Cycle 105: one POST, undici pool already empty. Wrapped `isError` only if CallTool already entered `execute()`. |

GET `/mcp` (`mcpServer.ts` L508–531) is **not** idle: timeout 0 +
`setKeepAlive(true)`. `closeIdleConnections` would leave it.
`mcpShutdown` / `closeAllConnections` closes it (cycle 72/93).
HTTP/1.1 cannot POST CallTool on that SSE socket, so a Hermes
that opened GET must open a **new** TCP for `tools/call` — the
inbound row above, not cycle 105’s wrap.

Idle keep-alive POSTs that *already* sit on Node (direct-to-PORT
tests, or an unverified nginx upstream keepalive) would still hit
L298 after `close()` and then mcpFetch-fail. Wrap CallTool after
#2 that only waits, then close, still loses that window. Cycle 98
`draining=true` at `disableCron` / A-019 refuse is the gate, not
`closeIdleConnections` from this cycle (that API would drop idle
Hermes without waiting a sibling GET SSE).

Do not HTTP-split `/mcp` to get a second close. Hermes/OMP: one
process, process exit *is* close.

## Queue effect

A-006 stays **discard**. Q-001 stays **ready** (404 reinit / proxy
error, not a POST retry). Q-014 stays **ready**. A-019 stays
**park** (refuse at `disableCron`, not a close API).

## Next

Cycle 107: cheapest remaining. Candidate: what status nginx
returns when upstream `:8080` is closed (502 vs 504) — not in
this tree’s conf (`proxy_next_upstream` absent). Do not un-ready
Q-001 / Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
