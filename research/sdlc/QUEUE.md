# Architecture / SDLC queue

Source of truth: `research/sdlc/queue.json`. **Not** the product queue.
Product implementation order is still Q-001 → Q-014 → Q-003.
`coding_unlocked: true`.

Thesis: `THESIS.md`. Comparison: `COMPARISON.md`. Module map:
`MODULE_MAP.md`. Services DAG: `SERVICES_DAG.md`. A-007 map:
`A-007-split-map.md`. Hops: `COMPOSITION.md`.

## Ranked (architecture track)

| Rank | ID | Score | Status | Title |
|---|---|---|---|---|
| 1 | A-001 | 32 | **ready** | Modular monolith thesis (this folder) |
| 2 | A-007 | 29 | **ready** | Split `apiTools.ts` — first file `tools/infrastructure.ts` (wait on kvnloo#2) |
| 3 | A-002 | 28 | **ready** | CI import boundary for `loops/core` |
| 4 | A-008 | 26 | **ready** | Folder-move creative cluster + re-export |
| — | A-015 | 31 | park | Do not add `generate_image` to `ANONYMOUS_TOOLS` |
| — | A-011 | 30 | park | Do not unify MCP vs Emma `generate_image` schemas in Q-014 |
| — | A-014 | 29 | park | Do not copy pageToolMap / FOUNDATION_TOOLS onto MCP list |
| — | A-005 | 23 | park | File-size ratchet — 7 PRs on `agentModeService.ts` |
| — | A-010 | 23 | park | codingAgent ↛ agentModeService (not a subprocess) |
| — | A-016 | 23 | park | mcp/client ↛ mcp/server (DAG already true; wait on #3) |
| — | A-018 | 28 | park | Copy isInternal skip onto DB MCP load path (not a fifth listen) |
| — | A-020 | 29 | park | Second `put-lifecycle-hook` after Immutable verify |
| — | A-019 | 27 | park | Refuse new `track()` **and** `tryClaim` while draining |
| — | A-017 | 19 | park | Stop CRM/worker importing `server.ts`; expand sessionSockets emit |
| — | A-004 | 19 | park | Split `emma/tools.ts` after #2832 |
| — | A-013 | 16 | park | Stop services importing HTTP controllers (#2393 owns Slack) |
| — | A-003 | 16 | park | Wire `executeAgentStep` (Harsha / Q-010) |
| — | A-009 | 15 | park | Do not invert `llmClients` ↔ meter to copy OMP |
| — | A-012 | 14 | park | Stop `agentModeService` importing `controllers/blog` |
| — | A-006 | 6 | **discard** | HTTP nanoservice per tool |

Cycle 61: AgentWebPro still empty on `apiTools.ts` / `loops/core` /
`sessionSockets.ts` / worker / `crmEnrichmentService`. `crm.ts` is
**#1544 + #1790**. `app.ts` is **#2271 + #1814**. Cycle 62: only
`server.ts` L186 `socket.join(\`user:${userId}\`)`; CRM uses `socket.id`;
codingAgent L1828 emits `sessionId` with no join. A-017 is a
passthrough. Cycle 63: ten dynamic `await import('../server')` sites
(gtmPlan L1495, admin L4749, durableLanding L237, agentModeController
**seven**) plus the three cycle-59 requires. A-017 first slice still
the two `require`s, not the 15k controller. Cycle 64: worker IPC
already splits `'progress'` (SSE / `sseProgress.ts`) from
`'socketEmit'` (A-017). `RunEmitter` typed sink is `() => {}`
(`agentModeService.ts` L3449); only `emitLegacy` is live. A-017 is
Socket.IO only. Cycle 65: `sseProgress` Maps live on the **parent**
(`workerService.ts` L8 / L322 `clearTerminalProgress` on child death).
Child worker has zero `sseProgress` imports. Same in-memory family
as `instanceState.ts` L10–11 (no Redis). Chatbot is a third fanout
(`chatSocketHandler.ts` L94 `socket.emit('message')`). Cycle 66:
`keyedMutex.ts` L12–15 — different processes never write the same
session. `tryClaimSessionGeneration` (`agentModeController.ts`
L936–956) is an in-memory Set. Cycle 67: MCP ENG-114 — no sticky
routing; scale-out is Dynamo metadata + in-process rehydrate
(`mcpSessionRehydration.ts` L3–8), not a fifth `listen()`.
`socialPosts.ts` L16–21 says MinSize=MaxSize=1; DR doc L112 says
MaxSize=4 — do not treat either as live AWS. Cycle 68: ASG
terminates before drain (`asgLifecycleGuard.ts` L4–16); the hook
calls **this** `drainForShutdown` (`server.ts` L572–574). A fifth
`listen()` is not in that hook. Cycle 69: `runDrain` L397–420 is
four named drains; inbound MCP `CallTool` is not one
(`mcpServerCore.ts` L88–120). `mcpShutdown` is unused by the main
server. Copy `chatbotTurn`, do not revive A-006. Cycle 70: wrap
`CallTool` once (covers local Map and `rehydrateAndServe`); do not
wrap only the ENG-114 face. Cycle 71: AgentWebPro empty on those
files; wrap after #2, not instead of Q-014. Cycle 72: local GET
`/mcp` SSE hangs `server.close()`; `mcpShutdown` after the wait,
not instead of it. Cycle 73: `server.close()` is not awaited
before `CompleteLifecycleAction` (`asgLifecycleGuard.ts` L262–273).
Cycle 74: `workerShutdownGuards.ts` (ENG-201) is why the existing
fork survives SIGTERM; a fifth `listen()` would not. Cycle 75:
`RecordLifecycleActionHeartbeat` is unused; 900s is CONTINUE
fallback (`eb-deploy.sh` L612). Cycle 76: GET `/mcp` is nginx/ALB
600s (`agent-mode-timeout.conf`), not `/socket.io/` 3600s.
Cycle 77: `generate_image` mcpFetch default abort is 5 min
(`httpClient.ts` L205); no `timeoutMs`. Cycle 78: leaf is 8 min
(ENG-510); MCP 5 min is the stricter face. Cycle 79: mcpFetch
abort does not cancel the leaf or skip the meter. Cycle 80:
MCP generate-image is outside `tryClaimSessionGeneration`; quota
is the brake. Cycle 81: that brake is `checkTokenUsage` then
`next()` (`emmaTokenBudget.ts` L171–196); increment is AFTER
vendor success (`meterUserUsage` void) and ADD does not refuse
overshoot. `reserveSpend` is unused on this path (ENG-1250
admission is Harsha). Cycle 82: image meter writes `$` with 0
tokens (`imageGeneration.ts` L551–563); default hard gate is
tokens (`tokenUsageService.ts` L342–396). Cycle 80 brake is
the cost dimension. Cycle 83: CallTool is not serialized
(SDK `streamId` per POST; rate limiter is count/min; rehydrate
is one transport per in-flight request). Cycle 84:
`checkExtraCostUsage` is tests-only; images do not write
`extraCostUsage` (CRM enrichment does). Cycle 85: default
image is $0.134 (`gemini-3-pro-image-preview`); `gpt-image-2`
is $0.04; cost caps are Dynamo not git. Cycle 86: `generate_video` is the same
`$` / 0-token meter; MCP does not list it. Q-016 stays parked. Cycle 87: AgentWebPro still empty on
`apiTools.ts` / `loops/core` / meter files (`llmPricing.ts`,
`emmaTokenBudget.ts`, `imageGeneration.ts`). Cycle 88: OMP
still 0.85.1; they unpublished experimental client/server.
Cycle 89: Hermes is still MCP client-only; parallel is opt-in
(default false). Cycle 90: file-config still skips
`"agentweb-tools"`; the Dynamo `mcp_servers` path does not.
Park A-018. Cycle 91: live HTTP face is `/mcp` only;
`/mcp/server` is stale inspector + AGENT_API L129. Product READY
unchanged. Cycle 92: that inspector is `--transport sse` against a
Streamable HTTP POST `/mcp`; GET `/mcp` without session is 400.
Product READY unchanged. Cycle 93: `mcpShutdown` still unused by
`runDrain`; on SIGTERM it runs **first** (`mcpServer.ts` L269–270
before `server.ts` L474–475) and `transport.close()`s inbound CallTool.
OMP still 0.85.1. Cycle 94: that closer does not `sessionStore.delete`;
only client `DELETE /mcp` evicts ENG-114. Product READY unchanged.
Cycle 95: this tree never sets `MCP_SESSION_STORE`; factory
default is memory. Dynamo rehydrate is opt-in, not git-proven live.
Product READY unchanged.
Cycle 96: Immutable + weekly refresh already overlap two instances
(`rolling.config` L3, `asgLifecycleGuard.ts` L4–9). `socialPosts.ts`
MinSize=MaxSize=1 is not in `.ebextensions`. Product READY unchanged.
Cycle 97: drain 503s only `/run-scheduled-chats`
(`agentModeController.ts` L13032). `/health` stays 200 (`app.ts`
L551–553). `backend/src/mcp/` has zero `isCronEnabled`. Product
READY unchanged.
Cycle 98: `cronJobRegistry.drain()` is a live `while (size > 0)`
(L68); `track()` has no `draining` flag. Worker already refuses
new `runInWorker` (L443). Wrap CallTool after #2 must copy that
pair. Product READY unchanged.
Cycle 99: `chatbotTurn` already `track()`s Socket.IO `'message'`
(`server.ts` L301) with no `isCronEnabled`. `io.close` is after
the wait. Product READY unchanged.
Cycle 100: Slack/email ack HTTP 200 then `track()` (`slack.ts`
L468 then L249; `webhooks.ts` L348 then `emmaEmailAgentTurn`
L291). Park A-019: one gate on the registry, not `slack.ts`
(#2393). Product READY unchanged.
Cycle 101: `POST /generate` never `track()`s — `tryClaim`
L9016 into `activeSessionGenerations`. A-019 first slice now
covers that Set too. Product READY unchanged.
Cycle 102: auto-continuation `setImmediate` after lock release
(L9406–9409) then `tryClaim` L1350. Re-fills the live Set.
Product READY unchanged.
Cycle 103: listed `emma_get_session` mcpFetchs that GET
(`apiTools.ts` L286, not `internal`). Hermes poll can start
billed continuation on the dying instance. Product READY
unchanged.
Cycle 104: listed `emma_send_message` mcpFetchs POST `/generate`
with no `timeoutMs` (default 5 min). Inner `generateResponse`
cancels on `req.close` (L9094–9104). Product READY unchanged.
Cycle 105: that POST is not retried on `fetch failed`
(`httpClient.ts` L116–118; test L163–176). GET `emma_get_session`
retries 3× into a closed listener and still fails (`server.ts`
L411–413). Hermes on the new instance never sees the old
`isError`. Product READY unchanged.
Cycle 106: inbound `/mcp` and loopback mcpFetch are different
sockets. `closeIdleConnections` is typed (`http.d.ts` L420–425)
and unused. Hermes hits nginx; mcpFetch is `localhost:${PORT}`.
Product READY unchanged.
Cycle 107: close() is nginx **502 now**, not the 600s 504.
`proxy_connect_timeout 600s` does not wait on ECONNREFUSED.
Classifier: 502 `upstream_5xx`, 504 `timeout`, loopback
`network`. Product READY unchanged.
Cycle 108: ALB health cannot stop Hermes during drain. Zero
`HealthCheckPath` in git. `/health` stays 200 until close
because mcpFetch needs the listen (ENG-1189). Hook
`CompleteLifecycleAction` then deregisters. Product READY
unchanged.
Cycle 109: `underlying_health_verdict` is deploy-verify (ENG-878),
not drain. Zero `backend/src` callers. `LAGGING` is post-terminate
stale Red. Product READY unchanged.
Cycle 110: weekly refresh (`Sun:10:00`, `InstanceRefreshEnabled`)
overlaps without `eb-deploy.sh`. A-019’s window is weekly, not
only on merge. Product READY unchanged.
Cycle 111: Sunday recycle and Immutable do **not** stack a third
backend. Must be Ready; wait 1200s or fail. Product READY
unchanged.
Cycle 112: 3×1200s settle is **not** a wait. Never-Ready
`fail()`s attempt 1 (`eb-deploy.sh` L639–640 / L155–158). Total
budget 2700s caps retries. Product READY unchanged.
Cycle 113: last deploy’s hook dies with the Immutable ASG.
Sunday recycle is not that hook. Park **A-020**. Product READY
unchanged.
Cycle 114: guard still drains without a hook; ASG does not wait.
Two IMDS `Terminated` reads; `disableCron` first. Product READY
unchanged.
Cycle 115: Sunday still gets OS SIGTERM; this tree does not keep
it alive. 900s is Immutable command Timeout, not recycle.
Product READY unchanged.
Cycle 116: log-retention names `systemd-journald`, not the Node
unit. Sunday `TimeoutStopSec` is live-AWS-only. Product READY
unchanged.
Cycle 117: `runDrain` never stops nginx. Stop order is
live-AWS-only. Product READY unchanged.
Cycle 118: `PORT=8080` is not in git. `.env.example` is 3001.
Only git `proxy_pass` is `/socket.io/`. Product READY unchanged.
Cycle 119: cannot name platform nginx.conf (`app.ts` L152–155).
Docs default upstream 5000. Product READY unchanged.
Cycle 120: git never chooses among 3001 / 8080 / 5000. Zero
`application:environment` in `.ebextensions`. Product READY
unchanged.

## First SDLC coding (only after product unlock, and not instead of Q-014)

1. **A-002** — AST import guard on `loops/core` only. **New**
   `loopsCoreImportGuard.test.ts` — do not append to
   `sdkConstructionGuard.test.ts` (#2563). Copy `visit()` L41–68.
   Allow exactly `orchestrator` / `instanceRunner` → `../index`. Also
   walk `loops/index.ts` (only `./core/types`). Do **not** copy
   forbid-all-services onto `agentMode/core` or `mcp/server`.
2. **A-007** — `mcp/server/tools/infrastructure.ts` (five mcpFetch
   tools including `generate_image`). Not `content.ts` (that section
   dynamically imports `agentModeService`). Not 85 Hermes files.
3. **A-008** — `git mv` + **path shim** at `services/imageGeneration.ts`
   (`export * from './creative/imageGeneration'`). Not `swarm/index.ts`.
   Boundary test `creative ↛ agentModeService`.
4. **A-005** — only after the `agentModeService.ts` PR pile shrinks.

Never A-006. Never a Kubernetes slice of Emma as a first architecture PR.
