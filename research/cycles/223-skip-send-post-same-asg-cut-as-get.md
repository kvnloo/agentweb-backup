# Cycle 223 — skip-send POST is the same CompleteLifecycleAction cut as GET

**Date:** 2026-09-12T05:15:00Z
**Question:** Cycle 222: skip-send
does not `stream.cleanup()`.
`runDrain` `server.close` is
unawaited (`server.ts` L440);
`CompleteLifecycleAction` does
not wait on it (cycle 73). After
skip-send the POST SSE is still a
Node HTTP connection until Hono
`writable.end()`. File-level only:
is `mcpShutdown`’s sync
`forEach(cleanup)` enough for
`server.close` to see the
connection finish, or can ASG
`CompleteLifecycleAction` cut the
orphaned POST the same way cycle
73 named for GET?

**Answer:** **Same cut as GET.**
`mcpShutdown` `forEach(cleanup)`
is enough to *start* Hono
`writable.end()` so the connection
is finite. It is not joined.
`runDrain` still fire-and-forget
`server.close` (L440) then
`await`s vendor MCP client +
telemetry and returns. The hook
then `completeAction` (L273).
Do not await `server.close` in
A-019. Do not add A-021.

## Evidence

The hook’s contract is drain
resolve, not sockets gone:

```212:214:backend/src/services/asgLifecycleGuard.ts
 * `onTerminating` is invoked at most once and is expected to perform the graceful
 * drain. Once it resolves, the lifecycle action is completed so the ASG can proceed
 * immediately instead of waiting out the hook.
```

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

`onTerminating` is
`drainForShutdown` (`server.ts`
L572–574). After the four-way wait,
`runDrain` does **not** await close:

```440:462:backend/src/server.ts
  server.close((err) => {
    if (err) {
      console.error('Error closing HTTP server:', err);
    } else {
      console.log('HTTP server closed');
    }
  });

  io.close((err) => {
    if (err) {
      console.error('Error closing Socket.IO:', err);
    } else {
      console.log('Socket.IO connections closed');
    }
  });

  await agentModeService.shutdown();
  await (await import('./observability/tracing')).flushTelemetry();
};
```

`gracefulShutdown.test.ts`
L223–230 still only pins
`drainCallIndex < serverCloseIndex`
in the source, not that the
callback ran.

`mcpShutdown` `close()` is sync
`_streamMapping.forEach(cleanup)`
(`webStandardStreamableHttp.js`
L604–613). Skip-send POST cleanup
is `streamController.close()`
(L500–508), same as GET L231–239.
Hono `flow({done})` then
`writable.end()` is a **later**
tick (`@hono/node-server`
`dist/index.mjs` L285–288). Cycle
214: `close()` returns before that
`read()`. Triggering
`controller.close()` makes the
connection finite; joining
`server.close` is **not** that
fix.

Skip-send POST headers are
`Connection: keep-alive`
(L487–488), same family as GET.
Until `writable.end()`, it is
**not** idle: cycle 106, GET is
`setKeepAlive(true)` and
`closeIdleConnections` would leave
it. `@types/node/http.d.ts` L425
`closeIdleConnections` still has
**zero** `backend/` callers.
Do not add it in A-019 (mcpFetch
still needs the listen during the
wait; after skip-send the POST is
in-flight SSE, not idle).

ASG does **not** `process.exit`
after drain (that is SIGTERM
`gracefulShutdown` L466–471). It
releases the instance. Force-exit
is the drain-ceiling timer (L379–382),
not the hook.

## First-slice correction (A-019 stays ready)

Keep wait-then-`mcpShutdown` then
unawaited `server.close`. Add:

- Do **not** await `server.close`
  to join skip-send POST (cycle
  214: not the closer; cycle 73
  cut is shared with GET).
- Do **not** add
  `closeIdleConnections` /
  `closeAllConnections` (cycle
  106; skip-send POST is not idle
  until Hono `end()`).
- Do **not** treat
  `CompleteLifecycleAction` as
  “sockets gone” for that POST.
- Do **not** drop `mcpShutdown`
  after the wait (without it
  `server.close` hangs on the
  leftover POST SSE — cycle 72 /
  222).

Do not wire `extra.signal`. Do not
503 `notifications/cancelled`.
Do not add HTTP. Do not add A-021.

## Relation to A-002 / A-007 / A-008

A-019 is still the architecture
item after #2+#3. This cycle only
puts skip-send POST on the cycle
73 cut. Not A-006.

## Next cycle

Sunday SIGTERM is
`gracefulShutdown` → drain →
`process.exit(0)` (`server.ts`
L466–471). ASG does not exit.
After A-019 `mcpShutdown`,
file-level only: does
`process.exit(0)` cut Hono’s
pending `flow({done})` before
`writable.end()`, so Sunday kills
the skip-send POST harder than
ASG `CompleteLifecycleAction`?
