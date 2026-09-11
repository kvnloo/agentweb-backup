# Cycle 64 — SSE / RunEmitter is not the Socket.IO bus

**UTC:** 2026-09-11T20:58:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 63: ten `import('../server')` sites emit on Socket.IO. Is Agent
Mode progress the same bus — and would merging them be the Hermes
move?

## Finding

**The worker already splits two fanout buses at IPC. A-017 is
Socket.IO only. `RunEmitter`'s typed sink is a no-op; SSE still
runs on `sseProgress.ts` + `emitLegacy`.**

### Two IPC types on the same fork

`generateMarketingResponseWorker.ts` L107–119:

| Worker callback | IPC `type` | Parent |
|---|---|---|
| `onProgress` L107 | `'progress'` | `generateMarketingResponseWorkerService.ts` L160–176 → caller |
| `socketEmit` L117 | `'socketEmit'` | L182–185 `require('../server'); io.to(room).emit` |

`generateSessionResponse` L8256 `runInWorker` passes L8282–8284
`(progress) => emitProgress(sessionId, progress)` — that
`emitProgress` is `utils/sseProgress.ts` L43 (in-memory
`sessionId` Map), **not** the local `crm.ts` L3245 helper that
`io.to(socketId).emit('import-progress')`. Same name, two modules.

SSE wire: `setupSSEConnectionForSession` L7788–7808
`Content-Type: text/event-stream`, `res.write(JSON.stringify(progress))`.
Keyed by **sessionId**, not `user:` / `socket.id`.

### RunEmitter is an in-process package with an empty sink

`agentModeService.ts` L3449:

```
new RunEmitter(agentRuntimeRunId, () => {}, onProgress)
```

`streamEvents.ts` L37–55: typed `StreamSink` + optional
`LegacyProgressSink`. Prod `runEmitter.emit(` — **zero** matches.
Only `emitLegacy` (L4194, L4776, …). `agentMode/core` does not
import `streamEvents`. The typed wire (`text-delta`,
`tool-input-available`, …) is not on SSE.

ARCHITECTURE.md §3 said “Progress is SSE via `RunEmitter`.” The live
path is **SSE via `sseProgress` / `emitLegacy`**. `RunEmitter` is the
OMP-shaped extract; the new contract is unwired.

### What this is not

Hermes: one transport per plugin, not one “realtime nanoservice.”
OMP streams in-process. AgentWeb already has HTTP + SSE + Socket.IO
+ worker IPC. Do not:

- absorb `sseProgress` into `sessionSockets` (A-017)
- HTTP-split SSE to “activate” the empty `StreamSink` (A-006)
- unify `crm.ts` L3245 `emitProgress` with `sseProgress.emitProgress`

A-017 first slice stays the two `require('../server')` sites.

## Queue effect

A-017 stays **park** (score 19). `first_slice` refined: Socket.IO
only. Product READY unchanged. A-006 stays discard (a fifth SSE
process would also miss `sseProgress`'s in-memory Maps).

## Next

Cycle 65: cheapest remaining mapping. Do not un-ready Q-001 /
Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
