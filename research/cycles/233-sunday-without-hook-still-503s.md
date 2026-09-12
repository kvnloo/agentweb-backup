# Cycle 233 — Sunday-without-hook still 503s; Wait is the park, not the 503

**Date:** 2026-09-12T06:28:00Z
**Question:** Cycle 232: Sunday `InstanceRefreshEnabled`
is weekly Immutable, not rolling. Cycle 113/114: the
surviving group may lack `agentweb-drain-before-terminate`
(A-020). Does A-019 `disableCron` still 503 without
`Terminating:Wait`, via SIGTERM `gracefulShutdown` (cycle
115), or does missing Wait skip the refuse?
**Answer:** **503 does not need Wait.** Missing hook skips
the park, not the drain. `startAsgTerminationGuard` still
calls `drainForShutdown` on two IMDS `Terminated` reads
(cycle 114; never checks a hook exists). Sunday still gets
OS/cgroup SIGTERM (cycle 115 / ENG-201). Both paths call
`disableCron()` first in `runDrain` (`server.ts` L384–387).
`runScheduledChats` already 503s that bit (`agentModeController.ts`
L13031–13032). After A-019, POST `/mcp` `tools/call` 503 is
the same bit. TODAY the sibling `mcpServer.ts` L269–270
closer still races Sunday SIGTERM and closes `/mcp` first
(cycle 213 → 502, not 503). A-019 drops that listener so
Sunday-without-hook is `disableCron` then wait-then-close,
cut by hypervisor (ENG-764 3m19s) instead of
`HeartbeatTimeout` 900s. Do not add `.platform` systemd. Do
not restore `.ebextensions/07-termination-lifecycle.config`
(ENG-818). Do not add A-021.

## Evidence

### Drain is invoked without a hook

```35:36:backend/src/services/asgLifecycleGuard.ts
 *   - The hook itself missing: `Terminated` is still reported for any termination, so
 *     the drain simply starts earlier than it otherwise would.
```

Poll loop (`asgLifecycleGuard.ts` L232–263): two exact
`Terminated` reads, then `await onTerminating()` →
`server.ts` L574 `drainForShutdown('ASG termination')`. Zero
`DescribeLifecycleHooks`. Test L267–283: `completeAction`
`AccessDenied` still drains once. Completing a missing hook
is a 14s retry *after* drain, not a skip of `disableCron`.

### SIGTERM is a second starter, also hook-independent

```465:475:backend/src/server.ts
const gracefulShutdown = async (signal: string) => {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  await drainForShutdown(signal);
  process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
```

`drainForShutdown` memoizes (`server.ts` L368–370): IMDS
first, later SIGTERM joins. SIGTERM first, IMDS joins. Either
way `disableCron()` is first (`L387`). Cycle 115: this tree
does not configure `TimeoutStopSec` for the Node unit.
Sunday without Wait is hypervisor vs that in-process drain
(`DRAIN_CEILING_MS` 10 min is not an OS wait).

`dev.md` L1853 names three platform SIGTERM sources (deploy,
autoscaling replacement, health-check restart). Only
replacement is delayed by the hook (`eb-deploy.sh` L611).
Sunday InstanceRefresh is still instance replacement (cycle
232: weekly Immutable).

### TODAY `/mcp` is close-first on Sunday SIGTERM

`app.ts` L204 `setupMcpServer` (via `server.ts` L2) registers
`mcpServer.ts` L269–270 **before** `server.ts` L475. Node
fires every listener. Sunday SIGTERM therefore
`transport.close()`s the shared StreamableHTTPServerTransport
while `gracefulShutdown` also starts `runDrain`. Cycle 213:
that is why A-019 **removes** the sibling `process.on`. Until
that lands, Sunday-without-hook Application 5xx on `/mcp` is
close-induced (nginx 502 after listen down / SDK throw), not
`tools/call` 503. `runScheduledChats` 503 is already live.

After A-019: one SIGTERM listener; `disableCron` then
four-way wait then `mcpShutdown` then unawaited `server.close`
then `process.exit(0)` (cycle 224: Sunday still exits; ASG
path must not). Without Wait, `process.exit(0)` and
SIGKILL can cut Hono `end()` and CONTINUE is N/A (no hook).

Hermes / Oh My Pi: one process, SIGTERM is the whole product.
AgentWeb’s cutting-edge SDLC is in-process refuse at
`disableCron` on **both** Wait and no-Wait Sunday, plus A-020
to buy the park. Not a fifth `listen()`. Not systemd from
A-019 (cycle 116: unit name live-AWS-only).

## First-slice correction (A-019 stays ready)

Keep wait-then-`mcpShutdown` then unawaited `server.close`.
**Keep** removing `mcpServer.ts` L269–270. Add:

- Do **not** treat missing `Terminating:Wait` as “A-019
  never 503s” (cycle 113 overclaim; cycle 114 already starts
  drain; cycle 115 SIGTERM also starts it).
- Do **not** add `TimeoutStopSec` / `KillMode` / `.platform`
  systemd from A-019.
- Do **not** restore `.ebextensions/07-termination-lifecycle.config`
  (ENG-818). A-020 stays park.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: without Wait, the dying instance is still an
ALB target until kill (DeregistrationDelay 600s is the target
group, `eb-deploy.sh` L217 / `ensure_deregistration_delay`;
ENG-764 3m19s is shorter). Can Hermes still see A-019 POST
`/mcp` 503 on that target after `disableCron` and before
SIGKILL, or does ALB/nginx 502 first? Do not 503 `/health`.
Do not set `HealthCheckType: ELB`. Do not add A-021. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006. Do not
mint a timer unless Kevin asks.
