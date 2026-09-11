# Cycle 58 — server.ts drain proves mcpFetch must share this listen()

**UTC:** 2026-09-11T20:41:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 57: `app.ts` is the Express/MCP/loops composition root. Where do
sockets, the fork, and cron attach — and what happens if image gen moved
to a fifth `listen()`?

## Finding

**`server.ts` is the process composition root. Drain (ENG-1189) already
documents that mcpFetch is loopback to *this* `listen()`. A fifth HTTP
image process would be a listen() the drain does not wait on.**

### Two roots, one OS process (until the fork)

| Root | Role | Citation |
|---|---|---|
| `app.ts` | HTTP routes, `setupMcpServer` L204, loop `register*` | cycle 57; #2271 owns the route table |
| `server.ts` | `http.createServer(app)` L56, Socket.IO L59, `listen` L549 | this cycle |

`server.ts` L41–44 also registers an in-process port (`registerFathomLinearPort`)
— LoopPorts-shaped, not HTTP.

### Drain is the composition proof

`drainForShutdown` L404–413 (ENG-1189): every in-flight tool
**self-calls this process** via `mcpFetch` `http://localhost:${PORT}`.
The marketing-response worker is a fork that **inherits the same PORT**.
Closing the listener first made those self-calls fail with `fetch failed`
for the rest of the process life. Drain now waits on worker + cron +
interactive turns **before** `server.close()`.

A-006 as a fifth `listen()` would need a copy of this drain (or it would
reproduce ENG-1189). Hermes keeps sockets and the loop in **one** process
so there is no second listener to drain. OMP stays in-process packages.

### Chatbot vs Agent Mode on this root

L288–291: Emma chatbot socket turns run **in-process (no fork)** and
still `executeTool` (including MCP-backed tools). L594–599: after
`initialize()`, pre-start the **worker** so *vendor* MCP clients are warm
— not a second Emma MCP HTTP server (cycle 45).

`shouldBootstrapBackgroundJobs()` (`instanceState.ts` L24–30) is in-memory.
Cron is not a nanoservice; it is a timer on this listen().

## Queue effect

None. A-007 still attaches at `mcpServerCore`, not `server.ts` / `app.ts`.
A-006 stays discard (new citation: ENG-1189 drain). Q-001 / Q-014 / Q-003
stay ready.

## Next

Cycle 59: cheapest remaining mapping or collision. Do not un-ready
Q-001 / Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
