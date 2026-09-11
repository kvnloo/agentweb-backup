# Cycle 62 — three Socket.IO room conventions; A-017 is a passthrough

**UTC:** 2026-09-11T20:55:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 60: A-017 copies Fathom `get`/`register`. What *room* does
`to(room).emit` address — and would unifying rooms be the Hermes move?

## Finding

**A-017 is a string-room passthrough. This tree already has three room
conventions. Only one has `socket.join`. Do not unify them in A-017.**

Prod `socket.join(` exists in **one** place:

```
server.ts L180–186  io.on('connection') → socket.join(`user:${decoded.userId}`)
```

Socket.IO also auto-joins every socket to a room named `socket.id`.

Callers already emit to three different strings:

| Convention | Citation | Join? |
|---|---|---|
| `user:${userId}` | `sessionSockets` password-change `in(\`user:${userId}\`)`; `toolDispatch.ts` L1198 `ports.socketEmit(\`user:${userId}\`, crmDataChanged)` | **Yes** — L186 |
| `socket.id` | `crm.ts` L3247 / L3647 / L6768 `io.to(socketId).emit`; V3 `crmEnrichmentServiceV3.ts` L907 `socketEmit(options.socketId, ...)` | Implicit default room |
| `sessionId` | `codingAgentService.ts` L1828 `context.socketEmit(context.sessionId, 'coding-agent-progress')` | **None** in this tree |

V3 enrichment (L904–908) already dual-emits socketId **and**
`user:${userId}` — the in-tree admission that those rooms are not the
same.

`agentMode/core/toolDispatch.ts` L368 already has optional `socketEmit`
on **dispatch** ports. That is not `LoopPorts` (`ports.ts` L143–150:
s3/dynamo/bedrock/slack/clock/logger). Cycle 60 stands: do not put
live rooms on the loop package.

Hermes Telegram is a plugin with its own chat id, not a unified room
type in `registry.py`. OMP does not merge CLI stdio with a socket room
enum.

A-017 `getIo().to(room).emit` must accept the same `string` the callers
already pass. Do not add `join(sessionId)`. Do not retarget coding-agent
progress at `user:` (A-010 neighborhood). Do not HTTP-split CRM.

## Queue effect

A-017 stays **park** (score 19). `first_slice` refined: passthrough
rooms; still not `crm.ts`; still not LoopPorts. Product READY unchanged.
A-006 stays discard.

## Next

Cycle 63: cheapest remaining mapping or stop if `stop_after`. Do not
un-ready Q-001 / Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
