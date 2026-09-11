# Cycle 102 — Auto-continuation re-fills the Set after drain release

**UTC:** 2026-09-11T22:26:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 101: `/generate` `tryClaim`s into `activeSessionGenerations`.
`runDrain` waits on that Set. Can **background** work re-claim the
same Set after the in-flight turn releases — so the live `while
(size > 0)` never sees empty — and does `disableCron` stop it?

## Finding

**Yes. Media and work-plan auto-continuation are
`setImmediate` (or same-tick recurse) after the lock is
released.** They `tryClaim` again with **zero** `isCronEnabled`.
That is not a new HTTP request. It is the waiter filling itself.
`disableCron` does not cancel `setImmediate`. A-019’s `tryClaim`
refuse is what stops this chain; a `track()`-only gate would not.

### Kickoff after release

`generateResponse` L9398–9409 (ENG-1239): if this turn deferred
`generate_image`/`video`, `setImmediate(() =>
scheduleAutoMediaContinuation(…))` so the continuation “claims
the generation lock only after THIS request has released it.”
L9418–9419: same pattern for stalled autocomplete work plans
(ENG-1684).

`scheduleAutoMediaContinuation` L1350: `if
(!tryClaimSessionGeneration(sessionId)) return;` then
`autoContinuationSessions.add`. No drain check. Usage gate
L1332–1345 (ENG-1239) is tokens, not instance state.
`isCronEnabled` in this file is still only `runScheduledChats`
L13031.

Chain: `finally` releases L1461–1462, then if `stillDeferred`
L1468 **calls** `scheduleAutoMediaContinuation(round + 1)`
(not even `setImmediate`). Live `drainActiveSessionGenerations`
(cycle 101) sees size go 1 → 0 → 1.

### A GET can start one

`getSession` L8725–8737: genuine owner view + unresolved media
deferral → another `setImmediate` continuation. A portal reload
during overlap can start billed background generation on the
**old** instance while the new one is already serving (cycle 96).

Q-014 `generate_image` is the leaf those continuations call
(mcpFetch, cycle 25). Do not HTTP-split the leaf to “isolate”
background images; the scheduler is this controller. Hermes/OMP:
no auto-continue Set. Cutting-edge SDLC is A-019 `tryClaim`
refuse (503/return, not 409), not a continuation nanoservice.

Do not edit this 14k file from the research timer. Do not land
A-019 instead of Q-014.

## Queue effect

A-019 stays **park**. First slice unchanged: `instanceState` bit
on `track()` **and** `tryClaim` (this cycle is why `tryClaim`
is not optional). A-006 stays **discard**. Q-014 stays **ready**.

## Next

Cycle 103: cheapest remaining. Candidate: `getSession` GET
backstop L8730 during drain — a read that starts generation.
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
