# Cycle 70 — two inbound MCP faces, one untracked CallTool

**UTC:** 2026-09-11T21:18:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 69: `runDrain` does not wait on inbound MCP. ENG-114 added a
second inbound face (`rehydrateAndServe`). Does that path already
bound the request (so Node `server.close()` waits), and would wrapping
only rehydrate cover Q-014 `generate_image`?

## Finding

**No. Both faces share `mcpServerCore` `CallTool`. Wrap that once.
Rehydrate is finite HTTP; local sessions linger. mcpFetch still
needs a new loopback either way — ENG-1189 still applies.**

### Two POST `/mcp` faces (`mcpServer.ts`)

| Face | Citation | Transport lifetime |
|---|---|---|
| Local hit | L307–315 `sessions.has` → reuse `StreamableHTTPServerTransport` | Process-local `Map` L196; stale cleanup L215–235; `mcpShutdown` L245–257 |
| Cross-instance miss | L396–445 `sessionStore.get` → `rehydrateAndServe` | Create, serve, `transport.close()` in `finally` (`mcpSessionRehydration.ts` L15–18 / L115–118). JSON-response, **no lingering SSE** |

Neither face calls `cronJobRegistry.track`. Both execute
`mcpServerCore.ts` L88–120 `CallTool` → `mcpToolRegistry.execute`.
Q-014 `generate_image` (`apiTools.ts` L2096–2108) mcpFetchs
`/api/emma/generate-image` on **this** PORT from either face.

### Why Node `close()` is not the waiter

Rehydrate’s Express request is finite, so `server.close()` can wait
on *that* socket. The inner `mcpFetch` is a **new** loopback
connection. ENG-1189 (`server.ts` L404–413): once `server.close()`
runs, that retry is permanently `fetch failed`. Local Streamable
HTTP may also hold an SSE stream, so `close()` may not even return
until sibling SIGTERM `mcpShutdown` — which the ASG path (cycle 68)
has not fired yet.

`cronJobRegistry.ts` L1–9 already names the contract: “one-off
self-calling agent turns with no other drain coverage” /
“anything that self-calls mcpFetch back into this same process.”
Chatbot got `chatbotTurn`. CallTool did not.

Wrap at `CallTool` (covers both faces). Do not wrap only
`rehydrateAndServe`. Do not call `mcpShutdown` from `runDrain` as
the waiter (that **closes** local sessions). A-006 as a fifth
`listen()` would be a third face with no tracker.

Hermes: tool execute is the same promise the loop already awaits.
AgentWeb’s MCP *server* is a second inbound face ENG-1189 missed.

## Queue effect

A-006 stays **discard**. Q-014 stays **ready** (list ≠ drain wrap).
A-017 stays park. No new A-id — the in-process fix is the existing
`track()` helper when coding is on a product/architecture slice
that already touches `mcpServerCore`.

## Next

Cycle 71: cheapest remaining mapping. Do not un-ready Q-001 /
Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
