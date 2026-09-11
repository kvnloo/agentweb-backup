# Cycle 101 — `/generate` uses the session Set, not `track()`

**UTC:** 2026-09-11T22:25:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 100 parked A-019: one `draining` flag on
`CronJobRegistry.track()`. Does that catch HTTP Agent Mode
`POST /generate`, or is there a second in-flight map with no
gate — the `tryClaimSessionGeneration` candidate from cycle 98?

## Finding

**A-019 as `track()`-only is incomplete.** `POST /api/agent-mode/generate`
(`generateResponse` L8817) never calls `cronJobRegistry.track`.
It `tryClaimSessionGeneration`s into `activeSessionGenerations`.
`runDrain` waits on that Set **and** the registry as two of the
four named units. `verified-generate` is on *both* maps.
`isCronEnabled` in this controller is only `runScheduledChats`.

### `/generate` is the Set

`routes/agentMode.ts` L199–201: `POST /generate` →
`generateResponse`. Concurrent-request lock is
`tryClaimSessionGeneration` L9016 (409 `SESSION_BUSY`).
Same claim on ishare `generateSharedResponse` L10290.

`cronJobRegistry.track` appears **once** in this 14k-line
controller: `verifiedGenerateTurn` L14194. Comment L14177–186:
interactive verified-generate is tracked here so scheduled
`runVerifiedChat` is not double-counted; `runVerifiedChat` now
also claims the Set (ENG-1696). So `/verified-generate` would
hit A-019. `/generate` would not.

### Two live waiters, one missing close

`runDrain` (`server.ts` L415–419) `Promise.all`s worker,
`cronJobRegistry.drain()`, `drainActiveSessionGenerations()`,
live-voice. `drainActiveSessionGenerations` L1037 is the same
live `while (size > 0)` as the registry (cycle 98).
`tryClaimSessionGeneration` L951 has no drain flag — only
“already generating.” `isCronEnabled` is L13031 only
(scheduled chats 503).

During the four-way wait the listener is still up (cycle 97).
A new `/generate` can claim a free session, join the Set, and
hold `Terminating:Wait` until the 10 min ceiling. A-019 on
`track()` would still let that through.

Hermes/OMP: one loop, one in-flight set. AgentWeb’s cutting-edge
SDLC is **one `instanceState` draining bit** consulted by
`track()` *and* `tryClaim`, not a `/generate` nanoservice.
Expand A-019’s first slice; do not add A-020; do not start at
this 14k controller (A-017). Do not 409 `SESSION_BUSY` as the
drain signal — that is a lie. Scheduled chats already 503.

## Queue effect

A-019 stays **park** (score 27). First slice now: flag next to
`disableCron`; `track()` and `tryClaim` both refuse. Do not
edit `slack.ts`. Do not land this instead of Q-014. A-006
stays **discard**. Q-014 stays **ready**.

## Next

Cycle 102: cheapest remaining. Candidate: media auto-continuation
`tryClaim` (L1350 / L1629) during drain — background work that
can claim the Set after `disableCron`. Do not un-ready Q-001 /
Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
