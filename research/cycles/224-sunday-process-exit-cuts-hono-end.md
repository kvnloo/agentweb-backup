# Cycle 224 — Sunday `process.exit(0)` cuts Hono end I/O; ASG does not exit

**Date:** 2026-09-12T05:25:00Z
**Question:** Sunday SIGTERM is
`gracefulShutdown` → drain →
`process.exit(0)` (`server.ts`
L466–471). ASG does not exit.
After A-019 `mcpShutdown`, file-level
only: does `process.exit(0)` cut
Hono’s pending `flow({done})`
before `writable.end()`, so Sunday
kills the skip-send POST harder
than ASG `CompleteLifecycleAction`?

**Answer:** **Sunday kills harder.
Not always before `end()` is
called.** After A-019,
`mcpShutdown` `controller.close()`
usually queues Hono
`reader.read().then(flow)` so
`writable.end()` is *invoked* as a
microtask during the awaited
close. `end()` does not wait for
flush. Sunday then
`process.exit(0)`, which Node
documents as forcing exit while
async I/O is still pending. ASG
`completeAction` leaves the
process alive. Do not put
`process.exit` on the ASG path.
Do not replace Sunday exit with
`exitCode` in A-019. Do not await
`server.close`. Do not add A-021.

## Evidence

Sunday SIGTERM is drain then
exit. ASG is drain then CONTINUE:

```359:365:backend/src/server.ts
// Drain every in-flight unit of work, WITHOUT exiting.
//
// Split out of gracefulShutdown for ENG-764: the ASG termination guard needs to
// drain and then still be alive to answer its lifecycle hook (an exit here would
// strand the instance in Terminating:Wait until the hook timed out). Memoized on
// the promise, so the SIGTERM that follows an ASG-initiated drain joins the
// in-progress drain instead of starting a second one.
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

```212:214:backend/src/services/asgLifecycleGuard.ts
 * `onTerminating` is invoked at most once and is expected to perform the graceful
 * drain. Once it resolves, the lifecycle action is completed so the ASG can proceed
 * immediately instead of waiting out the hook.
```

A-019 awaits `mcpShutdown` after
the four-way wait, then the same
unawaited `server.close` as today
(`server.ts` L440). Vendored
`close()` is still sync
`forEach(cleanup)`
(`webStandardStreamableHttp.js`
L604–613). Skip-send POST cleanup
is `streamController.close()`
(L500–508).

Hono’s adapter is already parked
on a Promise `.then`, not a
`setTimeout`:

```265:293:backend/node_modules/@hono/node-server/dist/index.mjs
function writeFromReadableStreamDefaultReader(reader, writable, currentReadPromise) {
  const cancel = (error) => {
    reader.cancel(error).catch(() => {
    });
  };
  writable.on("close", cancel);
  writable.on("error", cancel);
  (currentReadPromise ?? reader.read()).then(flow, handleStreamError);
  return reader.closed.finally(() => {
    writable.off("close", cancel);
    writable.off("error", cancel);
  });
  function handleStreamError(error) {
    if (error) {
      writable.destroy(error);
    }
  }
  function onDrain() {
    reader.read().then(flow, handleStreamError);
  }
  function flow({ done, value }) {
    try {
      if (done) {
        writable.end();
      } else if (!writable.write(value)) {
        writable.once("drain", onDrain);
      } else {
        return reader.read().then(flow, handleStreamError);
      }
```

Skip-send idle POST is the pending
`reader.read().then(flow)` arm
(L272). `controller.close()`
fulfills that read with
`{done:true}` → `writable.end()`
in a **microtask** during
`await Promise.allSettled(closePromises)`
(`mcpServer.ts` L256). That is
usually *before* `runDrain`
reaches `agentModeService.shutdown()`
and before Sunday `process.exit(0)`.

`end()` is not joined. Node’s own
types say `process.exit()` does
not wait for later ticks:

```869:892:backend/node_modules/@types/node/process.d.ts
                 * Calling `process.exit()` will force the process to exit as quickly as possible
                 * even if there are still asynchronous operations pending that have not yet
                 * completed fully, including I/O operations to `process.stdout` and `process.stderr`.
                 *
                 * In most situations, it is not actually necessary to call `process.exit()` explicitly. The Node.js process will exit on its own _if there is no additional_
                 * _work pending_ in the event loop. The `process.exitCode` property can be set to
                 * tell the process which exit code to use when the process exits gracefully.
                 *
                 * For instance, the following example illustrates a _misuse_ of the `process.exit()` method that could lead to data printed to stdout being
                 * truncated and lost:
                 * ...
                 * The reason this is problematic is because writes to `process.stdout` in Node.js
                 * are sometimes _asynchronous_ and may occur over multiple ticks of the Node.js
                 * event loop. Calling `process.exit()`, however, forces the process to exit _before_ those additional writes to `stdout` can be performed.
```

In-tree the same cut is why
`cronJobRegistry` exists:

```11:14:backend/src/utils/cronJobRegistry.ts
 * isCronEnabled()/disableCron() (instanceState.ts) stop a job from starting
 * its NEXT run. This registry covers the other half: if a job is already
 * running when gracefulShutdown() begins, drain() waits for it to finish
 * (up to a ceiling) instead of letting process.exit() cut it off blind.
```

`scheduledRunTracker.ts` L8 and
`scheduledRunTracker.test.ts` L8
name the same `process.exit(0)`
after drain.

If `flow` is waiting on
`writable.once("drain")` (L289–290),
`close()` does **not** call
`end()` until that event. Sunday
exit can then land *before*
`end()`. Skip-send with no further
SSE bytes is the pending-read arm,
not that backpressure wait.

After `mcpShutdown`, `runDrain`
still `await`s vendor MCP *client*
close (`agentModeService.ts`
L1738–1743 →
`mcpClientService.shutdown()`
L1889–1914, `await client.close()`
per client) and `flushTelemetry()`
(`tracing.ts` L321–326). Those
awaits are **not** Hono `end()`.
If `mcpInitialized` is false and
`!provider`, both return without
an inner await — Sunday
`process.exit(0)` follows in the
same microtask chain after
unawaited `server.close`. ASG
then still `await readInstanceId`
and `completeAction` (L268–273) —
macrotask HTTP — with the process
alive. Cycle 115: Sunday without
the hook never gets that gap;
this tree has no backend
`TimeoutStopSec`.

Do **not** put `process.exit` on
the ASG path (L359–365: would
strand `Terminating:Wait`). Do
**not** swap Sunday
`process.exit(0)` for
`process.exitCode` inside A-019
(Node types L894–905 recommend that
for stdout; Sunday lifetime is
A-020 / cycle 115, not the
billed-image gate). Do not await
`server.close` (cycle 214 / 223:
not the closer; cycle 73 cut
stays). Force-exit remains the
unref’d ceiling timer (`server.ts`
L379–382 `process.exit(1)`), not
this SIGTERM exit.

`gracefulShutdown.test.ts`
L223–230 still pins source order
only. Still zero `mcpShutdown`
and zero `process.exit(0)` hits
in that file.

## First-slice correction (A-019 stays ready)

Keep wait-then-`mcpShutdown` then
unawaited `server.close`. Add:

- Do **not** put `process.exit` on
  the ASG path (already true;
  cycle 73).
- Do **not** replace Sunday
  `process.exit(0)` with
  `exitCode` / omit-exit in A-019.
  That is Sunday process lifetime,
  not the billed-image gate.
- Sunday `process.exit(0)` can
  cut Hono `end()` I/O (and can
  cut *before* `end()` if `flow`
  is on `'drain'`). Document it.
  Do not join `server.close` to
  paper over it.

Do not 503 `notifications/cancelled`.
Do not add `closeIdleConnections`.
Do not add HTTP. Do not add A-021.

## Relation to A-002 / A-007 / A-008

A-019 is still the architecture
item after #2+#3. This cycle only
names Sunday exit vs ASG no-exit
for the leftover POST. Not A-006.

## Next cycle

When SIGTERM joins an
already-resolved ASG
`drainPromise`,
`gracefulShutdown` `process.exit(0)`
is immediate (L368–370 /
L466–471). File-level only: can
that fire while
`completeAction`’s
`readInstanceId` is in-flight
(both continuations after the
same drain resolve)? Do not add
A-021. Do not un-ready Q-001 /
Q-014 / Q-003. Do not revive
A-006.
