# Cycle 225 — SIGTERM on a settled `drainPromise` can `process.exit(0)` before `completeAction`

**Date:** 2026-09-12T05:32:00Z
**Question:** When SIGTERM joins an
already-resolved ASG
`drainPromise`,
`gracefulShutdown` `process.exit(0)`
is immediate (`server.ts` L368–370 /
L466–471). File-level only: can
that fire while `completeAction`’s
`readInstanceId` is in-flight
(both continuations after the same
drain resolve)?

**Answer:** **Yes.** `drainForShutdown`
memoizes drain only, not the hook
answer. SIGTERM on a settled
`drainPromise` is `await` then
`process.exit(0)` with **zero** join
to `readInstanceId` /
`completeAction`. That exit is a
microtask; IMDS/AWS are macrotask
HTTP. The fail-safe is already
HeartbeatTimeout 900s
`DefaultResult=CONTINUE`. Do not
await `completeAction` from
`gracefulShutdown` in A-019. Do
not add A-021.

## Evidence

Memoization is the drain promise,
not the guard’s CONTINUE:

```359:371:backend/src/server.ts
// Drain every in-flight unit of work, WITHOUT exiting.
//
// Split out of gracefulShutdown for ENG-764: the ASG termination guard needs to
// drain and then still be alive to answer its lifecycle hook (an exit here would
// strand the instance in Terminating:Wait until the hook timed out). Memoized on
// the promise, so the SIGTERM that follows an ASG-initiated drain joins the
// in-progress drain instead of starting a second one.
let drainPromise: Promise<void> | null = null;

const drainForShutdown = (reason: string): Promise<void> => {
  drainPromise ??= runDrain(reason);
  return drainPromise;
};
```

```465:475:backend/src/server.ts
const gracefulShutdown = async (signal: string) => {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  await drainForShutdown(signal);

  // Clean exit
  process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
```

No `once()`. No “ASG already
fired” skip. After A-019 the
sibling `mcpServer.ts` L269–270
listeners are gone, so this is
the SIGTERM path.

The hook’s CONTINUE is **after**
`onTerminating` resolves, and its
first line is another await:

```262:273:backend/src/services/asgLifecycleGuard.ts
    try {
      await onTerminating();
    } catch (drainError) {
      log.error('[asgLifecycleGuard] drain failed; releasing the instance anyway:', drainError);
    }

    try {
      const instanceId = await readInstanceId(fetchImpl);
      if (!instanceId) throw new Error('could not read instance-id from IMDS');
      for (let attempt = 1; attempt <= COMPLETION_MAX_ATTEMPTS; attempt += 1) {
        try {
          await completeAction(instanceId);
          break;
```

`readInstanceId` is IMDS HTTP
(`asgLifecycleGuard.ts` L157–168
→ `fetchImdsToken` L120–129 →
`imdsRequest` L103–116
`await fetchImpl`). That is a
macrotask. `completeAction` is
then `describeAutoScalingInstances`
+ `completeLifecycleAction`
(L178–194).

Two file-level windows:

1. **SIGTERM during drain**
   (the comment’s “follows /
   joins”). ASG attached to
   `drainPromise` first. SIGTERM
   attached second. On resolve,
   ASG’s continuation runs first
   and yields at `await
   readInstanceId`. The next
   microtask is SIGTERM
   `process.exit(0)`. CONTINUE
   is never called.

2. **SIGTERM after drain already
   resolved** (this cycle’s
   question). `await
   drainForShutdown` on a
   fulfilled promise is still a
   microtask, then
   `process.exit(0)`. If the
   guard is in `readInstanceId`
   or the 15×1s CONTINUE retry
   (`COMPLETION_MAX_ATTEMPTS`
   L83 / `COMPLETION_RETRY_DELAY_MS`
   L84), that I/O is aborted.

Node types already named the cut
(cycle 224: `process.d.ts`
L869–871).

`asgLifecycleGuard.test.ts`
L206–225 pins `['drain',
'complete']` in **one** interval
callback. Tests never inject
SIGTERM. `gracefulShutdown.test.ts`
still has **zero** `drainPromise`
/ `process.exit` /
`completeAction` hits.

The fail-safe is already in git:

```33:34:backend/src/services/asgLifecycleGuard.ts
 *   - CompleteLifecycleAction denied or erroring: the hook still expires on its own
 *     HeartbeatTimeout with DefaultResult=CONTINUE, so an instance is never stranded.
```

```290:294:backend/src/services/asgLifecycleGuard.ts
      // The hook's HeartbeatTimeout + DefaultResult=CONTINUE covers us here.
      log.error(
        '[asgLifecycleGuard] could not complete the lifecycle action; the hook will time out and continue on its own:',
        completeError
      );
```

```608:613:.github/scripts/eb-deploy.sh
  if ! out=$(aws autoscaling put-lifecycle-hook \
    --auto-scaling-group-name "${asg}" \
    --lifecycle-hook-name agentweb-drain-before-terminate \
    --lifecycle-transition autoscaling:EC2_INSTANCE_TERMINATING \
    --heartbeat-timeout 900 \
    --default-result CONTINUE 2>&1); then
```

Test L267–283 swallows
`completeAction` throw so an
unhandled rejection cannot crash
the dying instance. SIGTERM
`process.exit(0)` is a harder
cut than that throw: CONTINUE is
never attempted; 900s CONTINUE
is the wait.

Without the hook (Sunday recycle
after Immutable, cycle 113–114)
IMDS still starts drain; OS
SIGTERM is the instance-stop
path (cycle 115). That is where
windows (1) and (2) are live.
`completeAction` then fails
anyway (no `Terminating:Wait`);
the 14s retry is wasted work
SIGTERM can also cut.

With the hook, L18–19 says IMDS
`Terminated` is **before** any
SIGTERM. Whether EB withholds
SIGTERM for the whole
`Terminating:Wait` until CONTINUE
is **not** in this tree (same
class as Sunday `TimeoutStopSec`,
cycle 116). If SIGTERM still
arrives during the wait, window
(1)/(2) are live on Immutable
too. Do not treat L18–19 as a
pin that `process.exit` cannot
win.

Do **not** await
`completeAction` from
`gracefulShutdown` in A-019
(would couple the billed-image
gate to AWS IMDS). Do not
`process.exit` inside `runDrain`
(L359–365). Do not skip
`process.exit` when the guard
`fired`. HeartbeatTimeout is the
hook fail-safe; A-020 is the
Sunday wait.

## First-slice correction (A-019 stays ready)

Keep wait-then-`mcpShutdown` then
unawaited `server.close`. Add:

- Do **not** await
  `completeAction` /
  `readInstanceId` from
  `gracefulShutdown`.
- Do not fold the 900s hook
  timeout into A-019.
- SIGTERM `process.exit(0)` after
  a settled `drainPromise` can
  cut CONTINUE. Document it; the
  fail-safe is already
  HeartbeatTimeout.

Do not put `process.exit` on the
ASG path (cycle 224). Do not
replace Sunday exit with
`exitCode` in A-019. Do not await
`server.close`. Do not add A-021.

## Relation to A-002 / A-007 / A-008

A-019 is still the architecture
item after #2+#3. This cycle only
names that drain-join is not
hook-join. Not A-006.

## Next cycle

File-level only: does this tree
prove EB withholds SIGTERM for
the whole `Terminating:Wait`, or
is that live-AWS-only (cycle 116
`TimeoutStopSec` class)? Header
L18–19 asserts “BEFORE any
SIGTERM”; `workerShutdownGuards.ts`
L1–9 still says the OS delivers
SIGTERM to the cgroup on
shutdown/deploy. Do not add
A-021. Do not un-ready Q-001 /
Q-014 / Q-003. Do not revive
A-006.
