# Cycle 75 — ASG hook never heartbeats; 900s is a dead-man's switch

**UTC:** 2026-09-11T21:24:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 73: drain can return while GET `/mcp` SSE is open. If we
later **await** close (cycle 72 order), three clocks claim “900s.”
Does the guard extend the ASG hook while drain runs, or is 900s
a hard cap a fifth `listen()` would also miss?

## Finding

**`RecordLifecycleActionHeartbeat` is an IAM comment, never a
call. The 900s hook is DefaultResult=CONTINUE, not a keep-alive.
Drain is bounded by `DRAIN_CEILING_MS` 10 min so it finishes
inside that cap. A fifth process would need its own hook *and*
an API this process does not implement.**

### Three 900-second knobs, one unused API

| Knob | Citation | Role |
|---|---|---|
| `DRAIN_CEILING_MS` | `shutdownConstants.ts` L8 | 10 min wait for worker/cron/sessions/voice |
| Force-exit | `server.ts` L377–382 | ceiling + 3 min = 13 min, then `process.exit(1)` |
| EB rolling `Timeout` | `.ebextensions/rolling.config` L5–7 | 15 min; “must stay above force-exit” |
| ASG hook | `eb-deploy.sh` L608–613 `--heartbeat-timeout 900 --default-result CONTINUE` | park `Terminating:Wait` |

`asgLifecycleGuard.ts` L26 lists `RecordLifecycleActionHeartbeat`
among IAM grants. Repo grep: **that string exists only in this
comment.** `completeTerminationLifecycleAction` (L178–194) only
calls `completeLifecycleAction`. Tests never mock a heartbeat.

So a hung await (GET SSE without `mcpShutdown`, cycle 72–73) is
cut by force-exit at 13 min, still 2 min inside the hook’s 15 min
CONTINUE. The hook does not get a keep-alive; it just expires.

Wrapping Q-014 `CallTool` uses `cronJobRegistry.drain()`’s same
10 min ceiling. That still fits. Raising the ceiling past 15 min
to “wait on an image nanoservice” would let the hook CONTINUE
before drain finished — ENG-764 again.

Dynamo `runInFlight.heartbeatAt` (`agentModeController.ts`
L470–475, 5 min stale) is a **different** heartbeat (reconciler).
Do not copy it onto images (Harsha / `AW-ChatSessions` adjacent,
cycle 67). Hermes/OMP: one process, no ASG hook to heartbeat.

## Queue effect

A-006 stays **discard** (new citation: unused
`RecordLifecycleActionHeartbeat`; a fifth `listen()` is not in
`rolling.config`’s 900s either). Q-014 stays **ready**. A-017 stays
park.

## Next

Cycle 76: cheapest remaining mapping. Do not un-ready Q-001 /
Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
