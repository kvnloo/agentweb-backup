# Cycle 107 — close() is nginx 502 now, not the 600s 504

**UTC:** 2026-09-11T22:45:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 106: inbound `/mcp` (nginx) and loopback mcpFetch (`PORT`)
are different sockets. Cycle 76: nginx `proxy_*_timeout 600s`
applies to `/mcp`. After `server.close()` refuses new upstream
TCP, does Q-001 wait those 600s (504) or fail immediately
(502)?

## Finding

**Refused upstream is 502 in milliseconds. The 600s in
`agent-mode-timeout.conf` is not that clock.** Same file sets
`proxy_connect_timeout 600s` *and* `proxy_read_timeout 600s`
(L5–7). Connect-refused does not wait for connect-timeout.
`.platform/nginx` has **zero** `error_page` /
`proxy_intercept_errors` / `proxy_next_upstream` (also zero
under `backend/`). Stock nginx maps immediate upstream connect
failure to **502**. The 600s read timeout is for an *already
connected* socket — GET `/mcp` SSE (cycle 72/76) → **504**.

### Three classes for one deploy event

| Face after close | Status | This tree’s classifier |
|---|---|---|
| Q-001 Hermes → nginx → closed listen | **502** now | `toolErrorClassifier.ts` L87 `status >= 500` → `upstream_5xx` (test L136) |
| GET `/mcp` SSE already connected, then quiet | **504** at 600s | L84 `408 \|\| 504` → `timeout` (test L159–160) |
| `emma_send_message` mcpFetch loopback | no HTTP; `ECONNREFUSED` (cycle 105) | L131 `ECONNREFUSED` → `network` |

This tree never remaps those nginx statuses. In-app Emma retries
“5xx/gateway” and `"fetch failed"` as one bucket
(`agentModeSystemPrompt.ts` L191). Q-001 Hermes sees nginx’s
**HTML/502**, not MCP `isError` (cycle 105 wrap is only if
CallTool already `execute()`d). Do not add `error_page` from
this cycle. Do not lower `proxy_connect_timeout` to “fail
faster” — refused already is instant; lowering it would 504
slow *accepts* during overload.

A fifth `listen()` sits behind none of this nginx (cycle 76).
Hermes/OMP: one process, no 502/504 split. AgentWeb’s
cutting-edge SDLC is A-019 refuse before close, so Hermes never
hits this 502 on the dying instance.

## Queue effect

A-006 stays **discard**. Q-001 stays **ready** (404 reinit or
fast 502, not a timeout). Q-014 stays **ready**. A-019 stays
**park**.

## Next

Cycle 108: cheapest remaining. Candidate: ALB health on `/` or
`/health` after close — nginx 502s those too (`app.ts` L547–553
never run), so the target group, not A-019, is what finally
stops Hermes. Do not un-ready Q-001 / Q-014 / Q-003.
Unsubscribe after `2026-09-12T06:00:00Z`.
