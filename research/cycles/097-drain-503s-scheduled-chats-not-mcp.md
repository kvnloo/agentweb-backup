# Cycle 97 — Drain 503s scheduled chats, not `/health` or `/mcp`

**UTC:** 2026-09-11T22:12:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 96: Immutable + weekly refresh already overlap two backends.
Cycle 73: `server.close()` is not awaited. Does that close happen
*while the new instance already serves `/mcp`* — and does drain
even fail the old target's health check so ALB would stop sending
Hermes there first?

## Finding

**Yes: Immutable waits for the new instance to be healthy before
removing the old one (`IgnoreHealthCheck: false`). Drain then 503s
only `POST /run-scheduled-chats`. `/health` and `/` stay 200.
`backend/src/mcp/` has zero `isCronEnabled` hits. `server.close`
is step 4 of that drain — after the four-way wait — so the new
instance is already on the ALB while the old one still answers
Hermes until Node finally refuses connections.**

### New instance is in service first

`.ebextensions/rolling.config` L3–4: `DeploymentPolicy: Immutable`
and `IgnoreHealthCheck: false`. EB does not terminate the old
instance until the new one is Green. Guard L4–9 is that sequence
in prod: new at 10:17:06, old removed 10:22:06.

`asgLifecycleGuard.ts` L18–21: IMDS `Terminated` is **before**
SIGTERM. Drain runs on the old process while the new `listen()`
is already up.

### What drain actually refuses

`instanceState.ts` L4–8 / L18–20 and `server.ts` L384–387:
`disableCron()` is first so agent-engine's next
`/run-scheduled-chats` is 503 and "reroutes to the new instance
within one 5-second poll."

That 503 is one handler: `agentModeController.ts` L13028–13032
(`'Instance draining — retry on new instance'`).
`gracefulShutdown.test.ts` L131–151 copies **that** pattern only.

### What drain does not refuse

`app.ts` L547–553: `GET /` and `GET /health` always
`{ status: "healthy" }`. `healthEndpoint.test.ts` L51–75 pins 200
with no drain case.

`backend/src/mcp/` — **zero** `isCronEnabled` / `disableCron`.
POST `/mcp` (`mcpServer.ts` L298) stays 200 during the four-way
wait. Q-014 `generate_image` can still start, still `mcpFetch`s
loopback, and is still untracked (cycle 69). Then `server.close`
(`server.ts` L440–446, not awaited) refuses the next loopback
(ENG-1189) while Hermes may already be on the new instance.

ALB `DeregistrationDelay` 600s (`deploy.yml` L217,
`ensure_deregistration_delay` after verify) drains *in-flight*
connections after deregister. It is not an MCP 503. A fifth
`listen()` would need its own health fail + 503; this process
does not even fail `/health`.

Hermes/OMP: one process, no ALB pair. AgentWeb already taught
agent-engine to hop on 503. Inbound MCP did not get that lesson.
Q-001's 404-reinit (cycle 91/95) is the overlap path, not a mesh.

## Queue effect

A-006 stays **discard**. Q-014 stays **ready**. Q-001 stays
**ready** (404 reinit, not a drain 503). Do not add `/mcp` 503
from this cycle — that is product, after #2.

## Next

Cycle 98: cheapest remaining. Candidate: new `/mcp` CallTools
during the four-way wait are untracked, then `server.close` kills
their loopback while Hermes may already be on the new instance
(split-brain of one tool). Do not un-ready Q-001 / Q-014 / Q-003.
Unsubscribe after `2026-09-12T06:00:00Z`.
