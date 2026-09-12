# Cycle 226 — `Terminating:Wait` does not pin SIGTERM withheld

**Date:** 2026-09-12T05:37:00Z
**Question:** File-level only:
does this tree prove EB
withholds SIGTERM for the
whole `Terminating:Wait`, or
is that live-AWS-only (cycle
116 `TimeoutStopSec` class)?
Header L18–19 vs
`workerShutdownGuards.ts`
L1–9.

**Answer:** **Live-AWS-only.**
`asgLifecycleGuard.ts` L18–19
is a **comment** that IMDS
`Terminated` is reported
before instance-stop
SIGTERM. Tests never inject
SIGTERM. `dev.md` L1853 names
**three** platform SIGTERM
sources; only autoscaling
replacement is delayed by
`agentweb-drain-before-terminate`.
Do not treat L18–19 as a pin
that cycle 225’s race cannot
happen with the hook. Do not
add `TimeoutStopSec` /
`KillMode` from A-019. Do not
await `completeAction` from
`gracefulShutdown`. Do not
add A-021.

## Evidence

L18–19 is header prose, not
a runtime gate:

```17:22:backend/src/services/asgLifecycleGuard.ts
 * This module is the "something":
 *   1. Poll IMDS for `autoscaling/target-lifecycle-state`. It flips to `Terminated`
 *      as soon as the ASG decides this instance is going away — BEFORE any SIGTERM.
 *   2. On that signal, run the normal graceful drain (in-flight runs finish).
 *   3. Call CompleteLifecycleAction(CONTINUE) so the instance terminates immediately
 *      once drained, rather than sitting out the hook's full heartbeat timeout.
```

That sentence asserts
**IMDS-vs-instance-stop
order**. It does not say “no
SIGTERM can arrive while the
hook is `Terminating:Wait`.”
The runtime path
(`asgLifecycleGuard.ts`
L262–273) awaits
`onTerminating()` then
`readInstanceId` /
`completeAction`. Zero
`process.on('SIGTERM')` in
this file.

Tests pin drain-then-complete
in one interval tick and
“must not strand
`Terminating:Wait`” on drain
throw. They **never inject
SIGTERM**:

```206:225:backend/src/__tests__/asgLifecycleGuard.test.ts
  it('drains then releases the instance with the pinned hook name', async () => {
    const clock = makeClock();
    const order: string[] = [];
    const onTerminating = jest.fn(async () => {
      order.push('drain');
    });
    const completeAction = jest.fn(async () => {
      order.push('complete');
    });
    // ...
    expect(order).toEqual(['drain', 'complete']);
```

`rg SIGTERM asgLifecycleGuard.test.ts`
is empty. `gracefulShutdown.test.ts`
still has **zero**
`mcpShutdown` / `drainPromise`
/ `process.exit` /
`completeAction` hits (cycle
225).

`drainForShutdown` **assumes**
a later SIGTERM joins drain,
then still exits:

```359:365:backend/src/server.ts
// Drain every in-flight unit of work, WITHOUT exiting.
//
// Split out of gracefulShutdown for ENG-764: the ASG termination guard needs to
// drain and then still be alive to answer its lifecycle hook (an exit here would
// strand the instance in Terminating:Wait until the hook timed out). Memoized on
// the promise, so the SIGTERM that follows an ASG-initiated drain joins the
```

That comment is the same
class as L18–19: intended
order, not a pin that the
OS withholds the signal for
the whole Wait. When SIGTERM
does land, `gracefulShutdown`
awaits the (possibly already
settled) drain and
`process.exit(0)` (`server.ts`
L466–471) — cycle 225.

The tree **does** document
cgroup SIGTERM as a live
platform event, not as
hook-gated:

```1:9:backend/src/workers/workerShutdownGuards.ts
 * Guard a forked LLM worker against the raw SIGTERM/SIGINT the OS delivers to the
 * whole process group / cgroup during a graceful shutdown or deploy.
 *
 * The parent process (server.ts) orchestrates shutdown: on SIGTERM it disables cron,
 * stops accepting connections, and DRAINS in-flight worker requests (up to
 * DRAIN_CEILING_MS) so scheduled chats / EMMA runs can finish naturally, and only
 * then force-kills the worker. But the worker is a forked child that sits in the same
 * process group / cgroup, so it receives that SIGTERM at the same instant as the
 * parent.
```

Installed at worker module
load (`generateMarketingResponseWorker.ts`
L9–13). Parent teardown is
**SIGKILL**, never SIGTERM
(`generateMarketingResponseWorkerService.ts`
L380–383 / L426). Tests pin
worker ignore + parent
SIGKILL
(`workerShutdownGuards.test.ts`
L40–47;
`generateMarketingResponseWorkerService.test.ts`
L742–746). This tree never
sends SIGTERM to the parent;
it only **listens**
(`server.ts` L474–475 and
`mcpServer.ts` L269–270).

`dev.md` L1853 names **three**
sources, not one:

> When the platform terminates
> the instance (**Elastic
> Beanstalk deploy,
> autoscaling replacement,
> health-check restart**) it
> broadcasts SIGTERM to the
> **whole group**.

The hook is only
`autoscaling:EC2_INSTANCE_TERMINATING`
(`.github/scripts/eb-deploy.sh`
L611). Deploy and
health-check restart are
**not** that transition.
Cycle 115 said the hook
“only *delays* SIGTERM.”
That delay is the **intended**
ASG instance-stop order. It
is **not** proven in git that
EB withholds every SIGTERM
for the whole Wait, and it
does not cover the other two
sources.

No Node unit stop config in
git (same class as cycle
116):

- `.platform/` is four nginx
  confs. Zero `hooks/`.
- No `Procfile`.
- `.ebextensions` has no stop
  hook (`timeout.config` is
  ALB IdleTimeout 600 +
  ENG-823 note that
  DeregistrationDelay is
  **not** declared there;
  `05-instance-recycling.config`
  is Sunday 10:00 UTC
  `InstanceRefreshEnabled`;
  `06-log-retention.config`
  restarts
  `systemd-journald`).
- Only `TimeoutStopSec` in
  repo is
  `agent-engine.service` L82
  (**30s**, GCP) with
  `KillMode=mixed` L83.

`rolling.config`
`IgnoreHealthCheck: false`
is `aws:elasticbeanstalk:command`
(Immutable **deploy**). After
A-019 wait-then-close,
`/health` (`app.ts` L551–553)
can fail **while still
`Terminating:Wait`** (before
`completeAction`). Whether
that runtime fail can
health-check-restart SIGTERM
the parent in the cycle 225
window is **not** this cycle
(candidate 227). Do not 503
`/health` during drain
(cycle 108).

Hermes / Oh My Pi: one
process, no ASG hook, no
cgroup sibling. AgentWeb’s
cutting-edge SDLC is A-019
in-process (refuse + wait +
`mcpShutdown`) plus A-020
so Sunday has a Wait at all.
A fifth `listen()` would
still get cgroup SIGTERM
with Node’s default handler
(cycle 74).

## First-slice correction (A-019 stays ready)

Keep wait-then-`mcpShutdown`
then unawaited
`server.close`. Add:

- Do **not** treat
  `asgLifecycleGuard.ts`
  L18–19 as a pin that
  SIGTERM is withheld for the
  whole `Terminating:Wait`.
- Do **not** add
  `TimeoutStopSec` /
  `KillMode` / `.platform`
  systemd overrides from
  A-019 (cycle 116: unit
  name live-AWS-only;
  ENG-818).
- Cycle 225 still stands:
  if SIGTERM arrives in that
  window, `process.exit(0)`
  can cut CONTINUE;
  HeartbeatTimeout 900s
  `DefaultResult=CONTINUE`
  is the fail-safe.

Do not await
`completeAction` from
`gracefulShutdown`. Do not
put `process.exit` on the
ASG path. Do not replace
Sunday exit with `exitCode`.
Do not add A-021.

## Relation to A-002 / A-007 / A-008

A-019 is still the
architecture item after
#2+#3. This cycle only names
that L18–19 is not a
SIGTERM-withheld pin. Not
A-006.

## Next cycle

After A-019 `server.close`,
`/health` can fail while
still `Terminating:Wait`.
File-level only: can
`IgnoreHealthCheck: false`
(or a different EB health
knob) health-check-restart
SIGTERM the process in the
cycle 225 window? Do not
503 `/health`. Do not add
A-021. Do not un-ready
Q-001 / Q-014 / Q-003. Do
not revive A-006.
