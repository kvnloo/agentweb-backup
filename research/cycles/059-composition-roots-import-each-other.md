# Cycle 59 — two composition roots already import each other

**UTC:** 2026-09-11T20:45:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 58: `server.ts` is the process root and `app.ts` is the Express
root. Do those two roots stay acyclic — or does the tree already import
the listen module from inside HTTP?

## Finding

**`server.ts` imports `app`, and `app.ts` already imports `server.ts`
through CRM. The IoPort that was supposed to break that cycle exists and
is too small, so CRM and the worker still `require('../server')`.**

### The cycle ENG-1286 already named

`server.ts` L2 `import app from './app'`. L109–113 `export { io }` then
`registerIo(io)` so password-change cleanup does **not** import the
listen module.

`sessionSockets.ts` L9–12 already documents the rule: importing
`server.ts` boots `listen()` in tests. `admin.ts` / `controllers/auth.ts`
follow it (`disconnectStaleUserSockets` only).

`routes/crm.ts` L24 does **not**: `import { io } from '../server'`.
`app.ts` L40/L405 mounts that router. That is the cycle
`instanceState.ts` L24–30 (ENG-1286) exists for: any test that loads
`app` boots the real server via CRM, then the 30s cron timer fires into
the next Jest worker.

`crm.ts` is **7,815** lines. Four emit sites use the leaked `io`:

| Line | Call |
|---|---|
| L1746 | `socketEmit: (room, event, payload) => io.to(room).emit(...)` (enrich-v3) |
| L3247 | `io.to(socketId).emit('import-progress', ...)` |
| L3647 | `io.to(socketId).emit('icp-match-progress', ...)` |
| L6768 | `io.to(socketId).emit('group-email-progress', ...)` |

### Worker and enrichment copy the leak

`generateMarketingResponseWorkerService.ts` L181–189: worker IPC
`socketEmit` does `require('../server')` then `io.to(room).emit`. Cycle
46 already named this as the hexagon leak; the parent has Socket.IO,
the child does not.

`crmEnrichmentService.ts` L62–72 `getIO()` is the same
`require('../server')`, with a comment that `server.ts` binds the port
at module level (EADDRINUSE in workers). L74–78 `defaultSocketEmit`
wraps `to(room).emit`. The type `SocketEmitFn` (L60) is already the
port the IoPort should expose.

Tests still import the listen module: `__tests__/crmEnrichmentService.test.ts`
L95, `crm.groupEmail.test.ts` L26.

### The existing port is password-change only

`MinimalIo` today (`sessionSockets.ts` L20–22) is only
`in(room).fetchSockets`. Worker/CRM need `to(room).emit`. Expand that
interface; do not HTTP-split CRM.

Hermes packages do not import the CLI to get sockets. OMP `pi-ai`
does not import the coding-agent CLI. AgentWeb already has the DI
seam (`registerIo`) and then walks around it.

Open AgentWebPro: **#1790** still touches `routes/crm.ts` (stale
2026-07-08). **#1814** HubSpot is `crmSync.ts`, not this file. Do not
edit `crm.ts` as A-017’s first slice.

## Queue effect

Park **A-017** (score 19): stop `crm.ts` / `crmEnrichmentService` /
`generateMarketingResponseWorkerService` importing `server.ts`;
expand `sessionSockets` with `to(room).emit`. A-013 family (listen
module, not HTTP controllers). Not instead of Q-014. Not A-006.
Q-001 / Q-014 / Q-003 stay ready.

## Next

Cycle 60: does this IoPort belong on `LoopPorts`, or is there already a
complete in-tree analog? Do not un-ready Q-001 / Q-014 / Q-003.
Unsubscribe after `2026-09-12T06:00:00Z`.
