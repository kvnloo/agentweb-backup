# Cycle 74 — the fork ignores SIGTERM; a fifth listen() would not

**UTC:** 2026-09-11T21:22:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 68: the ASG hook parks the parent. Cycle 73: that parent’s
`server.close()` is not joined. The compute fork already exists
(cycles 44–46). Does it inherit the hook’s wait, or would A-006 as
a fifth `listen()` die the way the unguarded worker used to?

## Finding

**The fork *ignores* SIGTERM so the parent can drain then SIGKILL
(ENG-201). A fifth `listen()` is a sibling, not a child — it gets
the OS SIGTERM with Node’s default handler. That is the ENG-201
failure mode. Q-014 `generate_image` is parent inbound anyway.**

### The guard the research tree had not cited

`workerShutdownGuards.ts` L1–18 (installed at
`generateMarketingResponseWorker.ts` L9–13): the worker sits in
the same cgroup, so it receives SIGTERM at the same instant as
`server.ts`. Default handling aborted in-flight scheduled runs
(“signal SIGTERM” / zero assistant messages — ENG-201). Fix:
**ignore** SIGTERM/SIGINT; exit on IPC `disconnect`; parent
`kill('SIGKILL')` after `pendingRequests` drain
(`generateMarketingResponseWorkerService.ts` L379–384).

That wait is item 1 of `runDrain`’s four-way `Promise.all`
(`server.ts` L415–416). The ASG hook only parks the parent; the
child survives because the parent is still alive in
`Terminating:Wait` and owns the SIGKILL.

### Why A-006 does not inherit this

| Shape | SIGTERM | Drain waiter | ASG hook |
|---|---|---|---|
| Today’s fork | ignored; parent SIGKILLs | `workerService.shutdown()` | parent only |
| A-006 fifth `listen()` | default: **die** (ENG-201) | none (cycle 69 wait list) | none (cycle 68) |
| A-006 second fork | would need a copy of this file + a new `Promise.all` line | still not MCP/chatbot | parent still the only hook |

Q-014 `generate_image` is MCP on the **parent** (`apiTools.ts`
L2096–2108), not the worker (cycle 45). Worker guards do not cover
it. Hermes/OMP: one process, no cgroup sibling to ignore.

## Queue effect

A-006 stays **discard** (new citation: `workerShutdownGuards.ts` —
the in-tree rejection of “just add a process”). Q-014 stays
**ready**. A-017 stays park.

## Next

Cycle 75: cheapest remaining mapping. Do not un-ready Q-001 /
Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
