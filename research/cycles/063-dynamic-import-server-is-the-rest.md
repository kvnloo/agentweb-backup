# Cycle 63 — dynamic import('../server') is the rest of the leak

**UTC:** 2026-09-11T20:56:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 59 counted three `server.ts` importers (CRM static, worker
require, enrichment require). Cycle 62 said `user:` is the only
`socket.join`. Who else emits to that room — and did they already
dodge the static cycle?

## Finding

**The listen-module leak is ten dynamic `await import('../server')`
sites plus the three cycle-59 requires. They already knew the cycle
(`gtmPlan.ts` L12–13) and deferred it to handler time. A-017
`getIo()` is the replacement; do not start at `agentModeController.ts`.**

### Documented workaround, still a listen() import

`gtmPlan.ts` L12–13: “generateSessionResponse and io are imported
dynamically inside handlers to avoid loading server.ts → app.ts →
templates.ts chain at import time.” Then L1495
`const { io } = await import('../server')` and L1503
`io.to(\`user:${userId}\`).emit("gtm-session-ready", ...)`.

`admin.ts` does the same at L4749 / L4757 (password-change already
uses `sessionSockets` at L3 — mixed: one file, two patterns).

### Full prod importer list (this cycle)

| Kind | File | Sites | Event / room |
|---|---|---|---|
| static | `routes/crm.ts` L24 | 1 | `socket.id` progress (cycle 59) |
| require | `crmEnrichmentService.ts` L67 | 1 | `to(room).emit` |
| require | `generateMarketingResponseWorkerService.ts` L184 | 1 | IPC `socketEmit` |
| dynamic | `routes/gtmPlan.ts` L1495 | 1 | `user:` `gtm-session-ready` |
| dynamic | `routes/admin.ts` L4749 | 1 | `user:` `gtm-session-ready` |
| dynamic | `durableLandingService.ts` L237 | 1 | `user:` `session-message-appended` |
| dynamic | `agentModeController.ts` L1201, 1302, 1381, 1419, 1585, 1695, 1732 | **7** | `user:` `session-message-appended` |

### Who listens (this tree)

Partner-portal `GTMPlans.tsx` L292–300: `io(API_URL, { auth: { token } })`
then `socket.on("gtm-session-ready")`. No client `join()`. Server
`server.ts` L186 join on connect is enough for `user:` broadcasts.
`ChatSupport.tsx` L122 / L143 listens for `'message'` on the **socket
itself** (not a room) — chatbot path, not A-017.

`coding-agent-progress` still has **zero** listeners in this repo
(customer-portal is the other GitHub repo). Do not hunt it in A-017.

### What this is not

Hermes plugins do not `import` the CLI to emit. OMP packages do not
dynamic-import the coding-agent process. AgentWeb’s dynamic import is
still the listen module — it only moves the cycle from load time to
first GTM/continuation emit.

A-017 first slice stays worker + `crmEnrichmentService` `getIo()`
(cycle 61: those files empty on AgentWebPro). Do **not** fold the
seven `agentModeController` sites into that slice (14,929 lines;
A-005 pile). `durableLandingService.ts` is a later small getIo()
adopter (already tested). Do not HTTP-split GTM or landing.

## Queue effect

A-017 stays **park** (score 19). `first_slice` unchanged (two
`require`s). Later: gtmPlan/admin/durableLanding `getIo()`; never
the 15k controller as the first architecture PR. Product READY
unchanged. A-006 stays discard.

## Next

Cycle 64: cheapest remaining mapping. Do not un-ready Q-001 /
Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
