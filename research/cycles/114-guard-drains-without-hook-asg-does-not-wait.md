# Cycle 114 — guard still drains without a hook; ASG does not wait for it

**UTC:** 2026-09-11T23:00:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 113: Sunday recycle is rolling on the surviving Immutable
ASG, which never got `put-lifecycle-hook`. Without that hook,
does `startAsgTerminationGuard` still invoke `drainForShutdown`
before SIGKILL, or is IMDS `Terminated` too late?

## Finding

**The guard still calls `drainForShutdown` on two IMDS
`Terminated` reads. It never checks that a hook exists.** The
hook is what makes the ASG *wait* for that drain. Without it,
drain is a race against hypervisor kill — the same ENG-764
shape. The 3m19s receipt is two-instance overlap, not 3m19s of
`Terminating:Wait`.

`startAsgTerminationGuard` (`asgLifecycleGuard.ts` L232–296)
polls every `LIFECYCLE_POLL_INTERVAL_MS` **5000** (L69). Exact
`Terminated` must land twice (`CONFIRMING_READS_REQUIRED` 2,
L76; test L162–180 hardcodes 1 tick then fire). Comment L72–74:
two polls cost **5 extra seconds**. Then `await onTerminating()`
(`server.ts` L574 → `drainForShutdown('ASG termination')`).
`disableCron()` is **first** in `runDrain` (L387). A-019 would
fire if drain starts at all.

Missing hook is not a skip. Test L267–283: `completeAction`
`AccessDenied` still drains once. “No active Lifecycle Action
found” is retried as a **with-hook** propagation race (L79–81,
15×1000ms) **after** drain returns (L271–285). Without a hook
that error is permanent; the 14s retry does not make the ASG
wait. Comment L35–36: hook missing → `Terminated` still reported,
drain “starts earlier” than SIGTERM. Comment L12–15: SIGTERM
drain and 600s deregistration still do **not** make the ASG wait.

ENG-764 (`asgLifecycleGuard.ts` L4–9): new instance 10:17:06,
old **removed** 10:22:06. That 3m19s is two serving processes
(cycle 96), not park time. Removal is when the old OS dies. If
IMDS flips only then, confirming reads (5s) plus drain start
race the kill. `drainPromise` memo (L364–370) only joins SIGTERM
**after** drain has begun.

Do not HTTP-split to get a second SIGTERM. Hermes/OMP: one
process, no IMDS. AgentWeb’s cutting-edge SDLC is A-020 (ASG
waits) plus A-019 (refuse once `disableCron` runs). A fifth
`listen()` would miss this poll entirely.

## Queue effect

A-020 stays **park** (the wait). A-019 stays **park** (refuse is
the first line of a started drain). A-006 stays **discard**.
Q-001 stays **ready**. Q-014 stays **ready**.

## Next

Cycle 115: cheapest remaining. Candidate: does EB/OS still
send SIGTERM on Sunday Instance Refresh without our hook, so
`gracefulShutdown('SIGTERM')` starts drain even if IMDS is late?
Cite `server.ts` L474–475 vs `.platform` (zero SIGTERM config).
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
