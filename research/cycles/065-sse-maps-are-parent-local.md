# Cycle 65 — sseProgress Maps are parent-instance-local

**UTC:** 2026-09-11T21:00:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 64: worker IPC already splits SSE from Socket.IO. Where do the
SSE Maps live — and would a fifth process (or Redis) be the Hermes
move to share them?

## Finding

**`sseProgress.ts` is parent-instance-local, same family as
`instanceState.ts`. The child worker never imports it. A-006 as a
fifth `listen()` would need Redis or sticky sessions; this tree
already refused both for cron.**

### Child has no SSE module

`workers/generateMarketingResponseWorker.ts` — **zero**
`sseProgress` / `progressStore` imports. Progress leaves the child
only as IPC `type:'progress'` (cycle 64).

The **parent** service owns the Maps:
`generateMarketingResponseWorkerService.ts` L8
`import { clearTerminalProgress } from '../utils/sseProgress'`.
L311–322: on worker `error`/`exit`, clear every in-flight
`sessionId` so the frontend does not stream `"Thinking…"` forever
(`sseProgress.terminalCleanup.test.ts` L1–14). That cleanup only
works because the Maps and the `fork` parent share one heap.

`instanceState.ts` L10–11: cron flag is “intentionally in-memory
only — no DynamoDB or Redis needed.” `sseProgress.ts` L10–14 is
the same shape (`progressStore` + `activeConnections` Maps).

### Three fanouts, still one process

| Bus | Key | Citation |
|---|---|---|
| Agent Mode progress | `sessionId` Maps | `sseProgress.ts`; SSE `agentModeController.ts` L7791 |
| CRM/GTM/continuation | Socket.IO rooms | A-017; `user:` / `socket.id` |
| Emma sidebar | **this socket** | `chatSocketHandler.ts` L94 `socket.emit('message', …)` — no room, no SSE. `chatbotService.ts` has **zero** `sseProgress` imports |

MCP `mcpSessionRehydration.ts` L40 `accept: "application/json, text/event-stream"` is the **MCP Streamable HTTP** header, not Agent Mode progress. Do not treat it as a fourth SSE server.

Hermes: one transport per plugin, in-process. OMP streams in-process.
Do not introduce Redis to “compose” progress. Do not absorb
`sseProgress` into `sessionSockets`. Do not HTTP-split either bus.

## Queue effect

A-017 stays **park**. `first_slice` still the two `require`s;
Socket.IO only; do not move `sseProgress` Maps. A-006 stays discard
(a fifth process cannot see these Maps without a data-plane).
Product READY unchanged.

## Next

Cycle 66: cheapest remaining mapping. Do not un-ready Q-001 /
Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
