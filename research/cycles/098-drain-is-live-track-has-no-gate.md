# Cycle 98 — `cronJobRegistry.drain()` is live; `track()` has no gate

**UTC:** 2026-09-11T22:14:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 97: drain 503s only `/run-scheduled-chats`; `/mcp` stays
open. Cycle 69/70: wrap inbound CallTool with
`cronJobRegistry.track()` after kvnloo#2. Is that wait a
**snapshot** of jobs that existed when drain started, or a live
set that new `/mcp` CallTools would extend — and does `track()`
refuse new work the way the worker already does?

## Finding

**`drain()` is a live `while (inFlight.size > 0)` up to 10 min.
`track()` always inserts. The worker already learned `draining =
true` and rejects new `runInWorker`. The registry did not.
Wrapping CallTool with `track()` after #2, without a drain
admission (cycle 97: MCP has none), lets Hermes POSTs during
overlap hold `Terminating:Wait` until the ceiling.**

### Live wait, no close

`cronJobRegistry.ts` L62–76:

```
while (this.inFlight.size > 0 && Date.now() < deadline) {
  await sleep(pollIntervalMs);
}
```

Not a copy of the Map at start. `track()` L38–47 always
`inFlight.set`. No `draining` flag. Header L11–14: `disableCron`
stops a job from *starting*; `drain()` waits for what is already
running. Callers that skip `isCronEnabled` (MCP, cycle 97) skip
the first half.

`DRAIN_CEILING_MS` is 10 min (`shutdownConstants.ts` L8). Same
number as nginx/ALB 600s (cycle 76).

### The worker already has the missing half

`generateMarketingResponseWorkerService.ts` L363: `this.draining
= true` **before** its own live `while (pendingRequests.size > 0)`
(L368). L443–445: new `runInWorker` throws `'Worker is draining —
no new requests accepted'`. `gracefulShutdown.test.ts` L74 pins
that reject.

`drainActiveSessionGenerations` (`agentModeController.ts`
L1037) is the same live `while (size > 0)`.
`tryClaimSessionGeneration` L951 has no drain gate — only
"already generating." Interactive `/generate` is not Hermes.

### What wrapping CallTool would do today

`backend/src/mcp/server/` still has **zero**
`cronJobRegistry` imports (only `mcp/client/mcpOAuthRefreshService.ts`
L89 tracks `"mcpOAuthRefresh"`, and `runDrain` stops that
scheduler first — `server.ts` L389–395). Cycle 70's wrap is still
the right CallTool join. Copy the **worker** pair: set a closed
flag (or 503 `/mcp`) **then** `track()` wait. `track()` alone
turns cycle 97's open `/mcp` into a 10-minute drain extender.

A fifth `listen()` would need that pair on a process the ASG hook
does not wait on. Hermes/OMP: process exit is the close; they do
not HTTP-split to get a draining flag.

Do not land the wrap from this cycle (after #2, not instead of
Q-014). Do not add `/mcp` 503 on the research timer.

## Queue effect

A-006 stays **discard**. Q-014 stays **ready**. A-017 unchanged.
When coding the wrap: copy worker `draining`, not only `track()`.

## Next

Cycle 99: cheapest remaining. Candidate: `tryClaimSessionGeneration`
during drain (no gate) vs worker. Do not un-ready Q-001 / Q-014 /
Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
