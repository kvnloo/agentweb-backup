# Cycle 60 — IoPort stays host-level; copy Fathom, not LoopPorts

**UTC:** 2026-09-11T20:50:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 59 parked A-017: expand `sessionSockets` so CRM/worker stop
importing `server.ts`. Does that port belong on `LoopPorts` (the
Hermes package analog), or is there already a complete in-tree pattern?

## Finding

**A-017 copies `fathomLinearPortRegistry` (register + get). It does
not join `LoopPorts`. Chat sockets were already extracted the right way.**

### LoopPorts has no sockets — keep it that way

`loops/core/ports.ts` L143–150 is `s3` / `dynamo` / `bedrock` / `slack`
/ `clock` / `logger`. `loops/` has **zero** imports of `sessionSockets`,
`../server`, or `socket.io`. Putting `io` on `LoopPorts` would force
A-002 to allow a host Socket.IO type into the one folder that claims
zero host imports. Slack on LoopPorts is the **outbound** webhook
port, not live browser rooms.

Hermes does not put Telegram sockets in `registry.py`. OMP `pi-ai`
does not take a CLI socket handle.

### The complete analog is Fathom, not LoopPorts

| Seam | Register | Get | Importers of `server.ts`? |
|---|---|---|---|
| `fathomLinearPortRegistry.ts` | `server.ts` L41–44 | `fathomWebhook.ts` L39 `getFathomLinearPort()` | **No** |
| `sessionSockets.ts` | `server.ts` L113 `registerIo` | **missing** | Yes — CRM L24, worker L184, enrichment L67 |
| `chatSocketHandler.ts` | n/a — `server.ts` **imports** the handler | `ChatSocketLike` injected per event | **No** |

`chatSocketHandler.ts` L17–20 was extracted **from** `server.ts`
(ENG-1222) so tests do not boot `listen()`. Direction is
listen-module → handler, the opposite of CRM. Per-socket `emit` is
not `io.to(room).emit` — CRM/worker still need the room API on
`MinimalIo`.

A-017 first slice: add `getIo()` next to `registerIo`, matching
`getFathomLinearPort`. Switch the two `require('../server')` sites.
Leave `crm.ts` (#1790, 7,815 lines). Do not add a fifth `listen()`.

## Queue effect

A-017 stays **park** (score 19). `first_slice` is the Fathom analog,
not LoopPorts, not `crm.ts`. Product READY unchanged. A-006 stays
discard.

## Next

Cycle 61: collision refresh (last full check cycle 57; 20 open
AgentWebPro PRs). Do not un-ready Q-001 / Q-014 / Q-003.
Unsubscribe after `2026-09-12T06:00:00Z`.
