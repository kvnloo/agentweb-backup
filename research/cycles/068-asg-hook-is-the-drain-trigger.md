# Cycle 68 — ASG kill is faster than drain; the hook is process-local

**UTC:** 2026-09-11T21:06:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 58: `drainForShutdown` waits because mcpFetch is this PORT.
Cycle 67: scale-out is Dynamo metadata. What actually *stops* the
OS process on deploy — and would a fifth image `listen()` inherit
that wait?

## Finding

**SIGTERM drain and ALB deregistration are not enough. The ASG
terminates on its own clock. The shipped fix is an in-process
lifecycle guard that calls the same `drainForShutdown`. A fifth
process would need its own hook + IAM + deploy-script install.**

### The prod-verified gap (ENG-764)

`asgLifecycleGuard.ts` L4–16: immutable deploy 2026-07-29 added a
new instance at 10:17:06 and **removed the old one 3m19s later**. A
scheduled run started at 10:17:03 needed ~5.4 min. SIGTERM drain
(`DRAIN_CEILING_MS` 10 min) and ALB `DeregistrationDelay` 600s
existed; **neither makes the ASG wait**.

The missing piece is hook `agentweb-drain-before-terminate`
(L62): park `Terminating:Wait`, drain, `CompleteLifecycleAction`.

### Same drain, earlier trigger

`server.ts` L361–370: `drainForShutdown` was **split out of**
`gracefulShutdown` so the guard can drain and stay alive to answer
the hook (exit would strand `Terminating:Wait`). Memoized: SIGTERM
joins the in-progress drain.

L572–574: `startAsgTerminationGuard(() => drainForShutdown('ASG
termination'))` — **this** `listen()`, not a sibling service.

`.ebextensions` cannot create the hook (L51–57, ENG-818 / ENG-1184).
`.github/scripts/eb-deploy.sh` `ensure_termination_lifecycle_hook`
reinstalls it on every EB update.

Hermes/OMP: one process, no ASG hook. AgentWeb’s cutting-edge
SDLC here is **lifecycle + drain in the composition root**, not a
mesh. A-006 as a fifth `listen()` is a second ASG (or a process the
hook does not wait on) — it would reproduce session `d7e4863c`.

## Queue effect

A-006 stays **discard** (new citation: ENG-764 hook is per-process).
A-017 stays park (does not touch the guard). Product READY unchanged.

## Next

Cycle 69: cheapest remaining mapping. Do not un-ready Q-001 /
Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
