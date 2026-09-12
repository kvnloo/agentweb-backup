# Composition hops (research only)

Cycle 25. How AgentWeb *already* composes, vs a nanoservice mesh.

Hermes uses MCP as a **client** to other servers. AgentWeb’s MCP is a
**server** whose tools `mcpFetch` themselves on loopback. That is the
external composition bus. A fifth process would add a hop *after* the
policy method (category / HITL / persisted logo) **and** miss leaf
callers that already hit `imageService.generateImage` (meter + C2PA
default-on + CRITICAL LOGO live in that leaf — cycle 36).

## `generate_image` (the Q-014 / A-006 / A-008 specimen)

```
Hermes / Cursor
    │  MCP tools/call generate_image
    ▼
apiTools.ts L2096–2107   (internal: true today; Q-014 drops that flag)
    │  mcpFetch POST /api/emma/generate-image
    ▼
httpClient.ts
    getBaseUrl() = http://localhost:${PORT||3001}   L94–97
    lookupUser → await import('../../services/db') L63  (MCP is not loops/core-clean)
    POST is not retried (only GET/PUT, L118)
    │
    ▼
routes/emmaApi.ts L174–182
    authenticateToken + requireEmmaTokenBudget (ENG-973)
    getAgentModeService() → await import('../services/agentModeService')  L25–28
    │
    ▼
agentModeService.generateImage  L28857
    category must be ad | organic_post          L28876  (Q-014 keeps this)
    HITL confirm for edits                      L28893
    brand logo compositing (ENG-326 / 393)    L28920
    await import('./imageGeneration')            L28950  (cycle-break; A-008 re-export keeps this)
    │
    ▼
imageService.generateImage  (meter L5 + C2PA L575–578 + CRITICAL LOGO L477–484)
```

**Parent vs worker (cycle 44–46).** MCP’s hop above runs in the **EB
parent** (Express + `app.ts` L204 `setupMcpServer`). In-app Emma Agent
Mode does **not** take that hop:
`generateSessionResponse` L8256 `runInWorker` →
`child_process.fork` (`generateMarketingResponseWorkerService.ts` L98)
→ `workers/generateMarketingResponseWorker.ts` L16 `new AgentModeService()`
then L123 `generateMarketingResponse`. Same 40k class, second OS
process, 4GB heap, IPC for `publishAuthorizationOverride` /
`approvedRevisionImageSources`. Health checks stay on the parent
(L8254). Parent also keeps a **singleton** `agentModeService`
(`server.ts` L6, `initialize()` L594) for chatbot-without-fork (L288)
and `emmaApi`. Worker has no MCP HTTP server. `IS_MCP_SERVER` skip at
`initialize()` L1593 is unused in-repo — both processes load vendor MCP
clients. Do not add HTTP in front of this fork.

Cycle 46: the fork is already **hexagonal I/O vs compute**, not a
nanoservice. Parent owns HTTP / Socket.IO / cron
(`shouldBootstrapBackgroundJobs` `server.ts` L563; `instanceState.ts`
L10–11 in-memory) and MCP HTTP. Worker has no `listen(` and no cron
bootstrap. Worker L115–119 `socketEmit` IPC because it has no Socket.IO;
parent L181–189 `require('../server'); io.to(room).emit(...)`. The
hexagon **leaks**: Emma chatbot stays on the parent (`server.ts`
L288–291) and `chatbotService.ts` L5461 `executeTool` — so `generateImage`
already has **three** faces (parent MCP, parent chatbot, worker chat).
Hermes keeps sockets and the loop in one process. Do not HTTP-split
`generateImage`.

Cycle 58: **drain is the listen() proof.** `drainForShutdown`
(`server.ts` L404–413) waits on worker + cron + interactive turns
**before** `server.close()` because mcpFetch is loopback to this PORT
(ENG-1189). A fifth image `listen()` is not in that drain. `server.ts`
L41–44 `registerFathomLinearPort` is an in-process port at this root.

Cycle 59: **the two roots already import each other.** `server.ts` L2
imports `app`; `app.ts` L40/L405 mounts `crm.ts`, which L24
`import { io } from '../server'`. That is ENG-1286
(`instanceState.ts` L24–30). `registerIo` (`sessionSockets.ts` L9–12 /
`server.ts` L113) was the break; `MinimalIo` is only
`in(room).fetchSockets`, so `generateMarketingResponseWorkerService.ts`
L184 and `crmEnrichmentService.ts` L67 still `require('../server')`
for `to(room).emit`. A-017 expands that port. Not a fifth listen().

Cycle 60: **copy Fathom, not LoopPorts.** `fathomWebhook.ts` L39
`getFathomLinearPort()` never imports `server.ts`. `sessionSockets`
has `registerIo` and no `getIo()`. `chatSocketHandler.ts` L17–20 is
listen-module → handler (ENG-1222). `LoopPorts` L143–150 has no
Socket.IO; adding it would punch A-002.

Cycle 61: AgentWebPro still empty on `sessionSockets` / worker /
`crmEnrichmentService`. `crm.ts` is #1544+#1790. `app.ts` is
#2271+#1814 — A-007 still not `app.ts`.

Cycle 62: **three room strings, one join.** `server.ts` L186 is the
only `socket.join` (`user:${userId}`). CRM `io.to(socketId)` uses the
implicit socket-id room. `codingAgentService.ts` L1828 emits
`sessionId` and nothing joins it. `toolDispatch.ts` L1198 already
emits `user:` on dispatch ports, not LoopPorts. A-017 does not unify
these. Cycle 63: gtmPlan L1495 / admin L4749 / durableLanding L237 /
agentModeController (seven sites) `await import('../server')` then
emit to `user:`. `gtmPlan.ts` L12–13 is the documented load-time
dodge; it is still the listen module. A-017 `getIo()` replaces it.
Do not start that replacement at `agentModeController.ts`.

Cycle 64: **SSE is not Socket.IO.** Worker L107–119 sends
`type:'progress'` and `type:'socketEmit'` on separate IPC. Parent
progress path is `sseProgress.emitProgress(sessionId)` (controller
L8284) → `text/event-stream` L7791. `RunEmitter` L3449
`new RunEmitter(id, () => {}, onProgress)` — typed `emit()` unused;
only `emitLegacy`. `crm.ts` L3245 local `emitProgress` is Socket.IO
and must not be confused with `sseProgress`. A-017 does not absorb
the SSE Maps.

Cycle 65: **Maps stay on the parent heap.** Child worker has zero
`sseProgress` imports. `generateMarketingResponseWorkerService.ts` L8 /
L322 `clearTerminalProgress` on child death (zombie-"Thinking…"
fix). `instanceState.ts` L10–11 already refused Redis for cron.
`chatSocketHandler.ts` L94 is a third fanout (this socket, `'message'`).
MCP rehydration L40 `text/event-stream` is MCP protocol, not this
SSE. Do not introduce Redis. Do not HTTP-split.

Cycle 66: **the lock is the composition boundary.**
`keyedMutex.ts` L12–15: different processes never write the same
session. `activeSessionGenerations` (`agentModeController.ts` L936)
is a `Set`. `tryClaimSessionGeneration` is synchronous check-and-set.
A-006 as a fifth process would race that Set. A-017 does not touch
it. `cronJobRegistry.inFlight` is the drain-side Map (ENG-1189).

Cycle 67: **scale-out is ENG-114, not A-006.**
`mcpSessionRehydration.ts` L3–8: multi-instance, no sticky routing;
live transports cannot be shared; rehydrate in-process from
Dynamo metadata. `socialPosts.ts` L16–21 still documents a
process-local cooldown and a Dynamo fallback *if* ASG scales.
DR investigation L112 lists MaxSize=4 — in-tree disagreement; the
pattern is not a fifth `listen()`.

Cycle 68: **the ASG does not wait on drain.** `asgLifecycleGuard.ts`
L4–16 (session `d7e4863c`): SIGTERM + ALB 600s still lost a 5.4 min
run. Hook `agentweb-drain-before-terminate` + `drainForShutdown`
(`server.ts` L361–370 / L572–574). `.ebextensions` cannot install the
hook (ENG-818). A-006 would reproduce that kill.

Cycle 69: **inbound MCP is off the drain wait list.** `runDrain`
(`server.ts` L397–420) awaits worker / cron / `activeSessionGenerations`
/ live voice. Q-014 `generate_image` (`apiTools.ts` L2096–2108) is
localhost mcpFetch from `CallTool` (`mcpServerCore.ts` L88–120) with
no `cronJobRegistry.track`. `mcpShutdown` (`mcpServer.ts` L260–261)
is never called from `server.ts`. Chatbot was the last “untracked
path” (`server.ts` L288–301). Copy that wrap; do not HTTP-split.

Cycle 70: **two inbound faces, one wrap site.** Local
`sessions.has` (`mcpServer.ts` L307–315) reuses a lingering
Streamable HTTP transport. Cross-instance miss (L441) is finite
JSON (`mcpSessionRehydration.ts` L15–18 / L115–118). Both execute
the same untracked `CallTool`. `cronJobRegistry.ts` L1–9 already
describes this job. Wrap `CallTool`, not only rehydrate.

Cycle 71: **wrap files empty on AgentWebPro.** 20 PRs. Zero on
`mcpServerCore.ts` / `mcpServer.ts` / `mcpSessionRehydration.ts` /
`cronJobRegistry.ts` / `asgLifecycleGuard.ts` / `server.ts`.
kvnloo#2 / #3 MERGEABLE. Do not land the wrap on this research
branch. Do not start it instead of Q-014.

Cycle 72: **local GET `/mcp` is a keep-alive SSE.** L508–531
disables timeouts. Rehydrate has no GET (L516 404). `mcpShutdown`
must run **after** the CallTool wait, before `server.close()`.
Calling it during `generate_image` aborts the mcpFetch. A-006
would own a third GET with no closer.

Cycle 73: **close is not in the await the hook waits on.**
`server.ts` L440–455 fire-and-forget; `asgLifecycleGuard.ts`
L262–273 `await onTerminating()` then `completeAction`.
`gracefulShutdown.test.ts` L223–230 pins source *order*, not join.
`agentModeService.shutdown()` (L1729) closes vendor MCP clients, not
inbound SSE. Promisify close after `mcpShutdown`, still in-process.

Cycle 74: **the fork ignores SIGTERM; a fifth listen() would not.**
`workerShutdownGuards.ts` L1–18 (ENG-201): same cgroup, so the
child gets SIGTERM with the parent. Default handling aborted
scheduled runs. Parent waits `pendingRequests` then SIGKILL
(`generateMarketingResponseWorkerService.ts` L379–384). Q-014
`generate_image` is parent MCP, not this child. A-006 as HTTP
would die on the signal the worker was taught to ignore.

Cycle 75: **the ASG hook never heartbeats.**
`RecordLifecycleActionHeartbeat` appears only in
`asgLifecycleGuard.ts` L26. `eb-deploy.sh` L608–613 installs
`--heartbeat-timeout 900 --default-result CONTINUE`. Drain is
capped at 10 min (`shutdownConstants.ts` L8) so it finishes
inside; force-exit 13 min (`server.ts` L377–382); EB rolling
Timeout 15 min (`.ebextensions/rolling.config` L5–7). Awaiting
GET SSE without `mcpShutdown` is cut by force-exit, still inside
the hook. A-006 as a long image process would need a hook *and*
the API this process does not call.

Cycle 76: **Node timeout 0 loses to nginx/ALB 600s.**
`agent-mode-timeout.conf` L5–7 is global (no `location`).
`websocket.conf` L5–16 gives `/socket.io/` 3600s. GET `/mcp` is
not that path. ALB `IdleTimeout: 600` (`timeout.config` L5–6).
DeregistrationDelay is `ensure_deregistration_delay()` (ENG-823),
not `.ebextensions`. A-006 would copy three deploy artifacts and
still miss the Socket.IO exception.

Cycle 77: **inner hop is 5 min, not 10.** `httpClient.ts` L204–206
`timeoutMs ?? 5 * 60 * 1000`. `generate_image` (`apiTools.ts`
L2096–2108) does not override. Landing-page tools pass
`timeoutMs: 25 * 60 * 1000` (L1543) — already longer than nginx,
still mcpFetch to this PORT. A-006 would sit behind that abort.

Cycle 78: **leaf is 8 min; MCP is 5.** `IMAGE_GENERATION_TIMEOUT_MS`
(`imageGeneration.ts` L69–79) stays under the 10 min turn
(ENG-510). `withTimeout` L537–542. MCP never passes `timeoutMs`,
so Hermes loses 3 min of allowed vendor time. Align on this PORT
after #2; do not HTTP-split.

Cycle 79: **abort ≠ cancel.** `emmaApi.ts` L174–187 has no
`req.on('close')`. `withTimeout` races and does not abort the
vendor promise. Meter L546–562 still fires. A-006 would need a
distributed cancel this tree does not have. Align `timeoutMs`.

Cycle 80: **MCP is outside the session claim.**
`tryClaimSessionGeneration` lives only in `agentModeController`.
`keyedMutex.ts` L12–15 assumes that claim; prod uses are
`chatbotService.ts` L1078 / L1134. `emmaApi.ts` L174–182 has
quota, not a claim. Cycle 66’s “A-006 would race the Set” does
not apply to this face — there is no Set. Still do not HTTP-split.

Cycle 81: **that quota is check-then-act.**
`requireEmmaTokenBudget` (`emmaTokenBudget.ts` L171–196) GETs
`checkTokenUsage` then `next()`. Charge is AFTER vendor success
(`imageGeneration.ts` L546–562 `void meterUserUsage`).
`meterUserUsage` is fire-and-forget (`usageRecorderService.ts`
L482–531). `applyMonthlyChargeAtomic` conditions on **month**,
not remaining quota (`db.ts` L1878). `spendChargingService`
reserve/settle exists; **admission is absent** (L17–20, Harsha)
and unused by this leaf. Two parallel Hermes `CallTool`s can
both pass. A fifth `listen()` copies the GET. Do not wire
ENG-1250 onto Q-014.

Cycle 82: **image spend misses the default token gate.**
`meterUserUsage` from the leaf uses `costUsdOverride` with
`inputTokens: 0` / `outputTokens: 0` (`imageGeneration.ts`
L551–563). `checkTokenUsage` gates tokens unless
`ENFORCE_COST_CAP` or a versioned policy enforces cost
(`tokenUsageService.ts` L342–396). `spendChargingService` has
zero production imports. Do not flip the flag; do not HTTP-split.

Cycle 83: **CallTool is not serialized.** Local reuse
(`mcpServer.ts` L312–313 / L492) fans overlapping POSTs into one
SDK transport. SDK `handlePostRequest` (v1.25.2 L678) mints a
`streamId` per POST and `onmessage`s with no queue. OAuth rate
limit is 60/min (`mcpServer.ts` L142), not in-flight. Rehydrate
(`mcpSessionRehydration.ts` L16–18) is one transport per in-flight
request by design. A fifth `listen()` is not a serializer.

Cycle 84: **extra-cost admission is dead for images.**
`checkExtraCostUsage` (`tokenUsageService.ts` L663) has zero
production callers. `incrementExtraCostUsage` is CRM
enrichment only (`crmEnrichmentService.ts` L1958). Images write
`tokenUsage.totalCost` (cycle 82), not `extraCostUsage`. Do not
wire that API onto Q-014.

Cycle 85: **default image is $0.134.** MCP `image_model` is
optional (`apiTools.ts` L2090). Unset → Dynamo
`agent_mode_image_api_default_model` or leaf
`gemini-3-pro-image-preview` (`imageGeneration.ts` L492–494) at
`IMAGE_GENERATION_PRICING_USD` L301. `gpt-image-2` is $0.04
(Q-003). Cost caps are admin Dynamo; `FREE_TIER_FALLBACK` is
unlimited. A fifth process copies the book or bills $0
(`isPerGenerationPriced`).

Cycle 86: **video is the same meter, not on MCP.**
`videoGeneration.ts` L1098–1106 is `void meterUserUsage` with 0
tokens + `costUsdOverride`. `POST /generate-video` is already
`metered` (`emmaTokenBudget.ts` L59). `backend/src/mcp/` has
zero `generate_video`. Q-016 is list-like-Q-014 at 12–39× image
price. Do not HTTP-split; do not delay Q-014.

Cycle 87: **AgentWebPro still empty on Q-014 / meter / wrap.**
20 PRs. `#2875` is renewal-health cron. `#2862` still
`toolErrorClassifier.ts`. Zero on `apiTools.ts`, `loops/core`,
`llmPricing.ts`, `emmaTokenBudget.ts`, `imageGeneration.ts`.
Do not wait; do not HTTP-split to dodge collision.

Cycle 88: **OMP 0.85.1 unpublished a server split.**
`pi-coding-agent` `./client` is source-only; `pi-server` is a
devDependency. Images stay in `pi-ai` `sideEffects`. A-006 is
the shape they rolled back.

Cycle 89: **Hermes is still an MCP client.**
`discover_builtin_tools` skips `mcp_tool.py`.
`mcp_tool_server_run.py` is remote `MCPServerTask` lifecycle.
Parallel is opt-in (`supports_parallel_tool_calls`, default
false). `HERMES_MCP_OAUTH.md` does not set it. Q-014 lists;
Hermes serializes unless Kevin opts in.

Cycle 90: **self-MCP skip is file-config only.**
`initialize()` L420–432 still skips `mcp_config.ts`
`"agentweb-tools"`. Dynamo `mcp_servers` L435–450 does not.
Admin localhost URLs connect (`mcpServers.ts` L87–90);
`syncMcpAndRecycleWorker` L64–82 reloads parent + worker.
Discover L443–465 is a third `listTools` with no skip.
Park A-018. Do not HTTP-split.

Cycle 91: **live MCP face is `/mcp`.** `mcpServer.ts` L298/509/535
and OAuth metadata (`oauthRoutes.ts` L81) have no `/mcp/server`.
`mcp:inspector` and `AGENT_API.md` L129 are stale. Q-001 runbook
already uses `/mcp`. `github` in `mcp_config.ts` is stdio vendor,
not a self-loop.

Cycle 92: **`mcp:inspector` is SSE against a dead path.**
`package.json` L21 `--transport sse` + `/mcp/server`. Live
initialize is POST `/mcp`. GET `/mcp` SSE needs `mcp-session-id`
(L512–515) or 400. Q-001 is Streamable HTTP at `/mcp`. Do not
HTTP-split to make the inspector work.

Cycle 93: **`mcpShutdown` races `runDrain` on SIGTERM.**
`mcpServer.ts` L269–270 registers first (via `app.ts` L204 during
`server.ts` L2 import). `server.ts` L474–475 is second. SIGTERM
`transport.close()`s inbound CallTool, then drain waits. ASG still
drains before SIGTERM (cycle 68). Inspector cannot open GET;
Hermes can (`MCP_DISCOVERY.md` L15). OMP still 0.85.1.

Cycle 94: **`mcpShutdown` is local-only.** L245–257 and
`onclose` L382–387 never call `sessionStore.delete`. Only
`DELETE /mcp` L565/L583 does (ENG-114 AC #3). Dynamo rows
outlive SIGTERM so the next instance rehydrates. Do not evict
the store on drain. Do not HTTP-split session metadata.

Cycle 95: **`MCP_SESSION_STORE` is unset in this tree.**
`.env.example` / `.ebextensions/` / `.github/` have zero hits.
Factory default is memory (`mcpSessionStore.ts` L205–210).
`AW-MCPSessions` exists in `create-tables.ts` L1816. Do not flip
the env from Q-014. Live AWS console unverified.

Cycle 96: **immutable deploy already overlaps two instances.**
`rolling.config` L3 Immutable; recycle L13 `InstanceRefreshEnabled`.
Guard L4–9 is 3m19s overlap. `socialPosts.ts` L16–21 MinSize=MaxSize=1
is not in this tree. Default memory 404s Hermes across that window.

Cycle 97: **drain 503s scheduled chats, not `/mcp`.**
`IgnoreHealthCheck: false` (rolling.config L4) waits for the new
instance before removing the old. `disableCron()` 503s
`runScheduledChats` L13032. `app.ts` L547–553 `/` and `/health`
stay 200. Zero `isCronEnabled` under `backend/src/mcp/`.
`server.close` (L440, not awaited) is after that wait.

Cycle 98: **`drain()` is live; `track()` has no gate.**
`cronJobRegistry.ts` L68 waits on `inFlight.size`, not a snapshot.
Worker L363/L443 already refuses new work. `mcp/server/` still
has zero `cronJobRegistry` imports. Wrap CallTool after #2 must
copy the worker pair, or Hermes POSTs extend the 10 min ceiling.

Cycle 99: **`chatbotTurn` is the wrap preview.** `server.ts`
L286–301 tracks Socket.IO `'message'` with no `isCronEnabled`.
`chatSocketHandler.ts` has zero drain checks. `io.close` is after
the four-way wait. `/socket.io/` is 3600s. New Emma turns during
drain keep `inFlight.size` > 0.

Cycle 100: **Slack/email ack HTTP, then `track()`.** Slack events
L468 `res.status(200)` then `slackAgentTurn` L249. Resend
`webhooks.ts` L348 `void` then `emmaEmailAgentTurn` L291.
`server.close` does not abort after-ack work. Park A-019: one
`draining` flag on `track()`. Do not edit `slack.ts` (#2393).

Cycle 101: **`/generate` is the Set, not `track()`.**
`generateResponse` L8817 / L9016. `verifiedGenerateTurn` L14194
is the only `track()` in the controller. `drainActiveSessionGenerations`
is a second live waiter. A-019 must close `tryClaim` too.

Cycle 102: **auto-continuation re-fills the Set.**
`setImmediate` after `/generate` releases (L9406–9409).
`tryClaim` L1350, chain L1468. `getSession` L8730 GET backstop.
`disableCron` does not cancel `setImmediate`.

Cycle 103: **`emma_get_session` is a GET that is not a read.**
`apiTools.ts` L274–288, listed (`mcp.apiTools.test.ts` L71).
mcpFetch GET `/session/:id` → `setImmediate` continuation.
Hermes during overlap starts Q-014’s leaf on this PORT.

Cycle 104: **`emma_send_message` is a 5 min hop around `/generate`.**
L213–216, no `timeoutMs`; `httpClient.ts` L205 default 5 min.
Inner `req.on('close')` L9094–9104 `requestCancel`s. Inbound
CallTool untracked. Q-014 image hop does not cancel the leaf.

Cycle 105: **that POST is not retried after `server.close`.**
GET/PUT retry 3× (`httpClient.ts` L116–118); POST is one fetch
(test L163–176). Undici keep-alive default 4s (client.js L247)
<< 10 min drain. Wrapped `isError` stays on the old session.
Hermes on the new instance never reads it.

Cycle 106: **inbound `/mcp` and loopback are different sockets.**
`closeIdleConnections` typed at `@types/node/http.d.ts` L415–425,
zero callers. Hermes → nginx `:80`; mcpFetch `localhost:${PORT}`
bypasses nginx (`httpClient.ts` L94–96). `.platform/nginx` has
zero `keepalive`. GET `/mcp` SSE is not idle (L525–528).

Cycle 107: **close() is nginx 502 now, not the 600s 504.**
`agent-mode-timeout.conf` L5–7 sets both connect and read to 600s.
Zero `error_page` / `proxy_next_upstream`. Refused listen → 502.
SSE already connected → 504 at read timeout. Classifier splits
them (`toolErrorClassifier.ts` L84 vs L87).

Cycle 108: **ALB health cannot stop Hermes during drain.**
Zero `HealthCheckPath` in the repo. `healthEndpoint.test.ts` L51–75
pins always-200, no drain case. Failing `/health` during the wait
would yank the instance while mcpFetch still needs PORT.
`asgLifecycleGuard.ts` L262–288 then deregisters.

Cycle 109: **enhanced-health probe is deploy-verify, not drain.**
`eb-deploy.sh` L270–375 / L745–748. Zero `backend/src` callers.
`LAGGING` is new-instance-already-Ok after the old is gone.
Dry-run cannot change deploy exit (`deploy.yml` L213).

Cycle 110: **weekly refresh overlaps without that probe.**
`05-instance-recycling.config` L8–13. `deploy.yml` L199–204: EB
starts it, GitHub Actions does not. Same ASG hook, no
`underlying_health_verdict`.

Cycle 111: **Sunday + Immutable do not stack a third listen().**
`eb-deploy.sh` L668–680 Must be Ready. Wait 1200s (`deploy.yml`
L211) then fail. ENG-1127 abort is 31s ASG join, not a third fleet.

Cycle 112: **3×1200s settle is not a wait.**
`wait_for_environment_ready` `fail()`s (`eb-deploy.sh` L639–640,
`exit 1` L155–158) — it does not return to the attempt loop.
`EB_TOTAL_TIMEOUT_SECONDS` 2700 (`deploy.yml` L187) is the
absolute cap (`capped_deadline` L201–209). Test L518–534.

Cycle 113: **last deploy’s hook dies with the Immutable ASG.**
`put-lifecycle-hook` is before `update-environment` (`eb-deploy.sh`
L654–655; test L1066–1091 exactly one). `main()` after verify only
`ensure_deregistration_delay` (L895–897). Sunday
`InstanceRefreshEnabled` never re-puts. Park A-020.

Cycle 114: **guard still drains without a hook; ASG does not wait.**
Two IMDS `Terminated` reads (`asgLifecycleGuard.ts` L232–296;
test L267–283). `disableCron` is first in `runDrain` (`server.ts`
L387). 3m19s is two-instance overlap, not `Terminating:Wait`.

Cycle 115: **Sunday SIGTERM is OS/cgroup, not the hook.**
`server.ts` L474–475 only listens. `.platform` is nginx.
Only `TimeoutStopSec` in repo is agent-engine 30s.
`rolling.config` L7 900s is Immutable command Timeout, not
`InstanceRefreshEnabled`.

Cycle 116: **journald is not the Node unit.**
`06-log-retention.config` L42–43 `systemctl restart systemd-journald`.
`.platform` has no `hooks/`. `web.stdout.log` is a log file
(CLAUDE.md L544). Sunday `TimeoutStopSec` is live-AWS-only.

Cycle 117: **`runDrain` never stops nginx.**
`dev.md` L1934 `nginx.service`. `websocket.conf` L6
`proxy_pass 127.0.0.1:8080`. mcpFetch skips nginx
(`httpClient.ts` L94–96). `server.ts` L404–440 `server.close` only.
Sunday nginx-vs-Node stop order is live-AWS-only.

Cycle 118: **`PORT=8080` is not in git.**
`.env.example` L1 `PORT=3001`. Tests pin mcpFetch 3001
(`mcp.httpClient.test.ts` L27 / L239). Only git `proxy_pass` is
`/socket.io/`. `/mcp` is unvendored platform nginx.conf.

Cycle 119: **cannot name that nginx.conf.** `app.ts` L152–155
(ENG-493) says the general proxy location is not in this repo.
Zero `.platform/nginx/nginx.conf`. `dev.md` L6235 AWS docs:
extend dirs we already use; override path we do not ship;
default upstream **5000**. `trustProxy.test.ts` L9–10 is a live
access log, not a conf path. `/mcp` `proxy_pass` filename and port
are live-AWS-only. 600s timeout is in git (`agent-mode-timeout.conf`).

Cycle 120: **git never chooses among 3001 / 8080 / 5000.**
Zero `aws:elasticbeanstalk:application:environment` in
`.ebextensions`. Fixtures only (`eb-config-conflict.test.sh`
L304). `websocket.conf` L6 hardcodes 8080; Node fallback is 3001
(`server.ts` L55). Platform injects `PORT`; `/socket.io/` does not
read it.

Cycle 121: **a `/mcp` location is instance-only.**
`eb-config-conflict.sh` L190–193 every `*.platform/*` is
instance. Test L188–192 instance-only **passes**. L124–130 +
`timeout.config` is `EB_CONFIG_CONFLICT`. `eb-deploy.sh` is not
classified (L196–197). Do not add A-021.

Cycle 122: **detect-changes skips drafts.** `tests.yml` L16–18
`draft == false` on the parent job. Conflict job `needs` it
(L244–246). A draft `/mcp` PR never runs ENG-836. Pass still
refuses deployability (script L232–233; test L200–201).

Cycle 123: **re-draft is `NO_EVIDENCE`.** `merge-evidence.sh`
L262–267 exits 3 on `pr_draft`. Missing `converted_to_draft`
(`tests.yml` L5) does not let a `/mcp` PR merge. `gh pr checks`
can still look green (L14–25). Discriminator is
`Detect changed projects` (L147).

Cycle 124: **ENG-836 skip is not draft.** Discriminator has no
path filter (`merge-evidence.test.sh` L1426–1433). AC5: path-
filter skips do not block PASS. `BACKEND_JOBS` is only
`Backend build` (script L160). Conflict job `if: ebconfig`
(`tests.yml` L246) cannot be the discriminator (script L74–76).

Cycle 125: **5-minute string is the #2491 receipt.** Live
ceiling is 12 (`tests.yml` L248). `bad` excludes `cancelled`
(script L596). Test L860–877: hung conflict job is PASS.
`fetch-depth: 0` (L255) vs detect-changes `fetch-depth: 1` (L34).

Cycle 126: **in-flight ENG-836 is PENDING.** `n_pending` is
every incomplete check-run (script L726–728; test L318–322).
Backend and conflict use different concurrency groups
(`tests.yml` L73–75 vs L249–251). Required context is only
`Detect changed projects` (script L871–874).

Cycle 127: **ENG-1373 is still an unlanded comment.**
`merge-evidence.sh` L875 and `dev.md` L157 are present tense.
No script updates `required_status_checks`. `BACKEND_JOBS`
(L160) is script-local. Dependabot yml L20 is also a comment.
Auto-merge waits on the required set only
(`tasks/lessons.md` L237).

Cycle 128: **merge-evidence labels Dependabot skip as a
path-filter skip.** #2491 fixture L437 is `skipped` on a
different check_suite; the gate PASSes (test L452). L974
cannot tell a job-level `if` from a path-filter skip.

Cycle 129: **GitHub treats a job-level `if` skip as Success.**
Dependabot yml L46 is that skip. Workflow-level skip stays
Pending and blocks. Docs vs API: merge Success; conclusion
`skipped`. The REQUIRED comment only bites on Dependabot PRs.

Cycle 130: **naming `Backend build` as required cannot reproduce
merge-evidence section 7.** Every `tests.yml` job except Detect
changed projects is a job-level path skip (`tests.yml` L70).
GitHub required checks are names, not path-conditional.

Cycle 131: **no `PARTNER_JOBS`.** Test L1047: partner-only diff
PASSes with Partner skipped. Fixtures still say `Partner portal
tests`; live job is `Partner portal build`. Failure FAILs
(`n_bad`); skip/cancel does not.

Cycle 132: **no `WORKFLOW_JOBS`.** Test L1196–1198: editing
`merge-evidence.sh` PASSes with `CI script tests` skipped.
That job runs `merge-evidence.test.sh` (`tests.yml` L142).
The gate does not require the job that tests the gate.

Cycle 133: **ENG-1377 relay and remotion builds are unnamed**
in merge-evidence. Zero mentions in the gate or its tests.
Not in `NON_BACKEND`. Failure FAILs (`n_bad`); skip/cancel
does not.

Cycle 134: **a `tests.yml` PR schedules six jobs;
merge-evidence requires `Backend build` only.** `tests.yml`
is in backend / workflows / relay / remotion / ebconfig
filters. Cancelled relay is the same cancelled PASS as ENG-836.

Cycle 135: **agent-engine is a deploy unit with no GitHub
build job.** Grep of `.github/workflows/` is empty. Test L1199
PASSes `agent-engine/web_agent.py` as `NON_BACKEND`. Remotion
got ENG-1377; the Python worker did not.

Cycle 136: **customer-portal is a fifth repo (gitignored).**
`.gitignore` L121–124. No directory. `tests.yml` / `deploy.yml`
grep empty. Test L1044–1047 path is synthetic. CLAUDE.md L155
is stale vs L894.

Cycle 137: **the other repo’s IA is a typed list in this
backend.** `customerPortalPages.ts` L28–124;
`GET /customer-portal-pages` (`subscription.ts` L322–325).
Policy is the constant; HTTP is the other origin. Not A-006.

Cycle 138: **`growth-chat/` is a sixth origin; `callLLM` stays
here.** Gitignored L122; Actions grep empty.
`growthGeniusService.ts` L1 / L85 → `agentModeService.callLLM`.
A-006 would cut the gateway this product already shares.

Cycle 139: **Growth Genius is a fifth in-process catalog.**
Inline `search_knowledge_base` (L129–150) → Emma
`searchPlatformKnowledgeBase` (`chatbotService.ts` L4711).
Two god-objects, one turn, no HTTP.

Cycle 140: **the KB helper is a leaf; the file cycles.**
Function L4711–4867 is Vertex-only. `chatbotService.ts` L24
↔ `agentModeService.ts` L26. A-002 does not cover this.

Cycle 141: **ENG-1057 already named three KB faces.** Test
header L1–10; callers L5106 / L24059 / L71. Cap at the
source. Same lesson as `generate_image`.

Cycle 142: **those faces do not share source sets.** Agent
Mode `searchKnowledgeBase` L24059 calls the Vertex leaf, then
Drive (L24072, ENG-1624) and ClickUp docs/tasks (L24141 /
L24181). Emma RAG (`chatbotService.ts` L5093 / L5106) is
Vertex + local `findRelevantChunks` — zero Drive/ClickUp
imports. Growth Genius L71 is Vertex-only. Emma’s *tool*
(`emma/tools.ts` L5593) is the Agent Mode superset. HTTP-split
the Vertex leaf would not give GG Drive; extracting the whole
method would pull `clickupService` OAuth into a fifth
process. Not A-006.

Cycle 143: **listed MCP `search_knowledge_base` already hops
to that superset.** `apiTools.ts` L1264–1284 has no
`internal: true` and sits before the internal banner (L1936).
`emmaApi.ts` L98–101 calls Agent Mode. Sibling `generate_image`
is still `internal: true` (L2077). Test L78 vs L91. MCP’s
listed description (L1268) does not mention Drive/ClickUp;
the hop still walks them. Q-014 is listing, not a new hop.
Not A-006.

Cycle 144: **Agent Mode still recaps Vertex.** Leaf
`chatbotService.ts` L4800–4804 / L4852 already truncates.
Face L24065 plus `agentModeService.searchKnowledgeBase.test.ts`
L321–334 mock the leaf to 6000 chars. L24062 “never capped”
is stale. Drive/ClickUp caps at L24113 / L24161 / L24199
stay on the face (cycle 142). Not A-006.

Cycle 145: **three `searchKnowledgeBase` symbols.** Emma
export L4674 → `findRelevantChunks` L515 (Azure embeddings
over in-memory `knowledgeBase` L4293). Agent Mode L24032 is
the superset (MCP `emmaApi.ts` L101). Growth Genius L66 is
Vertex-only; inline schema L142–147 requires `reason`.
Hermes/OMP: one name, one handler. Not A-006.

Cycle 146: **three JSON schemas for that name.** GG L147
requires `query`+`reason`. Emma L5590 and MCP L1275 require
`query` only + `max_results`. Agent Mode test L66–74 pins
Emma’s shape. A-011 already parks this pattern for
`generate_image`. Do not add A-021. Not A-006.

Cycle 147: **GG `reason` never reaches the leaf.** L174 logs
it; L177 `searchKnowledgeBase(functionArgs.query, userId)`.
Tool result L188–192 is `{ query, results, count }`. Cycle 39
`confirm` *does* reach `generateImage` policy — that is why
A-011 parks unifying images. This field is the opposite
no-op. Not A-006.

Cycle 148: **cardinality is per-face.** GG L71 and Emma RAG
L5106 hardcode 10. Emma tool L5594 and MCP L1281 default 5.
Agent Mode L24050 caps at 10. Emma disagrees with itself
(RAG vs tool). Not a leaf port. Not A-006.

Cycle 149: **per-source collect, then slice.** L24230–24233:
merged list can be several times larger than requested.
Vertex is pushed first (L24059–24070); Drive tree walk
(L24080–24121) and ClickUp doc reads (L24150–24156) still
run; `slice(0, limitedMaxResults)` keeps the prefix. Listed
MCP `emmaApi.ts` L98–101 hops here. Not A-006.

Cycle 150: **no short-circuit after Vertex.** L24070 maps
Vertex; L24073 is `if (userId)` Drive. ClickUp L24142 /
L24182 same. Only empty-set gate is L24216. Grep: no
`results.length >= limitedMaxResults` in this method.
Listed MCP always fans out. Not A-006.

Cycle 151: **ClickUp docs “search” is list-all then
`includes()`.** `clickupService.ts` L103–119 paginates every
workspace doc (no query param; grep of that file for
`search`/`query` is empty). Agent Mode L24150–24158 reads
each doc’s pages until N matches. Drive L24092 is
`fullText contains` then read-hits-only. Listed MCP hops
here. Not A-006.

Cycle 152: **`listTasks` enriches attachments; search ignores
them.** `clickupService.ts` L219–258 paginates all tasks then
`getTask` in batches of 10. Search L24181 / L24194–24196
uses name+description only. `listKnowledgeBaseFiles` L24887
uses `attachmentCount`. One adapter, two contracts. Not
A-006.

Cycle 153: **`readDocContent` runs before `includes()`.**
Agent Mode L24155 computes `nameMatch`; L24156 always
`readClickUpDocContent`. `clickupService.ts` L137–165: list
pages then GET empty pages. Drive L24104–24109 reads
`fullText` hits only. Listed MCP hops here. Not A-006.

Cycle 154: **Drive has count+time bounds; ClickUp does not.**
ENG-1624 L23552–23581: folder count, `perBatchTarget`,
`DRIVE_LIST_WALK_MAX_MS = 90_000`. Search passes
`limitedMaxResults` (L24094). `clickupService.ts` grep
TIMEOUT/MAX_MS/deadline/AbortSignal/timeout is empty.
`listDocs` L106–119 is `do/while (cursor)`. Copy Drive’s
bound shape in-process. Not A-006.

Cycle 155: **ClickUp docs walk sequentially; Drive trees
do not.** Drive L24080–24082 `Promise.all` of
`getGoogleDriveFolderTreeIds` (each still
`DRIVE_LIST_WALK_MAX_MS`). ClickUp L24148–24156 nested
sequential `await`: workspace → `listDocs` → each
`readClickUpDocContent` (cycle 153 pages). Drive file
**content** reads after the query are also sequential
(L24105–24121). Parallelism without a deadline is a
worse blast radius. Not A-006.

Cycle 156: **Search reads are uncapped; other faces are
not.** `readGoogleDriveFileContent` L25194–25211
`responseType: 'arraybuffer'` with no size check.
`DRIVE_LIST_WALK_MAX_MS` is the folder walk, not this
download. Materialize L25781–25798 refuses at
`MATERIALIZE_ASSET_MAX_BYTES` (200MB, L25626). GCS
named-read L25393 and ClickUp named-read L25870 truncate
to 1M **after** fetch. Search face keeps 5000 chars
(L24113 / L24161). Copy the materialize shape in-process.
Not A-006.

Cycle 157: **Search Drive query omits `size`.** Search
L24093 `files(id, name, mimeType, parents)`. Listing
L24690 `files(id, name, mimeType, size, modifiedTime)`.
Named-read L25482 includes `size, modifiedTime, parents`.
Materialize L25678 includes `size, parents`. Helper L23941
`fields: nextPageToken, ${fields}`. Search cannot refuse
on metadata it never asked for. Not A-006.

Cycle 158: **Workspace exports have empty `size`.**
`readGoogleDriveFileContent` L25198–25206
`files.export` for Docs/Sheets/Slides. Named-read L25606
`file.size ? parseInt : contentStr.length` after the
export. Materialize L25781 missing size → 0, then
`buffer.length` (L25798). Cycle 157’s fields-string
change still covers binary files. Workspace needs a
post-download bound on the helper. Not A-006.

Cycle 159: **Hermes decomposed the MCP client, not a
server.** Live main: ~24 `mcp_tool_*` / `mcp_oauth_*`
files. `mcp_tool.py` docstring still says client. Registry
skip of `mcp_tool.py` is now L97 (cycle 89: L92). OMP
`v0.85.1` unchanged (2026-09-05). A-007 copies that
in-process split. Not A-006.

Cycle 160: **Loop still client; two opt-in stdio servers.**
`mcp_tool_server_run.py` L136 “manual /mcp refresh” is
`_reconnect_event`, not FastAPI. `mcp_serve.py` L721
`run_stdio_async()` conversations (`_TOOL_NAMES` L685–688).
`hermes_tools_mcp_server.py` stdio for Codex;
`EXPOSED_TOOLS` includes `image_generate`. Dashboard
`web_routers/mcp.py` is outbound OAuth. Cycle 89 overstated
the repo, not the loop. Not A-006.

Cycle 161: **Codex-facing `image_generate` is in-process.**
`hermes_tools_mcp_server.py` L90
`handle_function_call(tool_name, kwargs)`. Stdio
`server.run()` L139. `mcp_serve.py` is a second allowlist
(conversations only). AgentWeb Q-014 lists via mcpFetch
(`emmaApi.ts`); Hermes listed the leaf without that hop.
Not A-006.

Cycle 162: **Hermes schema ≠ MCP `generate_image`.**
Live `IMAGE_GENERATE_SCHEMA` L522–554: name
`image_generate`, required `prompt` only, `aspect_ratio`.
MCP L2093 requires `prompt`+`filename`+`category`.
Execute still forwards `input_images` (L2102). A-011
parks Emma vs MCP; do not add A-021 for Hermes. Not A-006.

Cycle 163: **Hermes capability-gates tools/list.**
`_build_dynamic_image_schema` L781–815. AgentWeb MCP
L2081–2093 is a static literal. Q-014 lists that literal.
Not A-006.

Cycle 164: **Leaf does not refuse t2i+edit.** Emma L5035
says gemini-2.5-flash-image is t2i-only;
`generateWithGoogleGemini` L924 still edits.
`validateParams` L1514–1533 has no matrix. Hermes
`_prepare_fal_request` L367–370 raises. Not A-006.

Cycle 165: **`logo_image` is mutated into `inputImages`
before routing** (L477–485). HITL L28893 keys off caller
`inputImages`, so logo-only skips confirm then takes
`/images/edits`. CRITICAL LOGO stays in this leaf. Not
A-006.

Cycle 166: **Four image-model catalogs.** MCP L2090 free
string; Emma L5036 seven ids; leaf L16–28 eight; admin
L2206 six (no Runway). Comment L2203 “must match” is
false. Partner-portal L8563 is a second copy of the
shorter list. Hermes `FAL_MODELS` is one. Not A-006.

Cycle 167: **HITL before catalog refuse.** L28893 then
L28991 then L502. MCP can confirm then `Invalid
imageModel`. Not A-006.

Cycle 168: **Runway `referenceImages`.** L1363–1390 after
the mutate. `textToImage.create` L1394. Admin omitting
Runway does not stop Emma/MCP from naming it. Not
A-006.

Cycle 169: **Azure `[0]` only.** L651 FormData one
`image`. Logo is last after L477–485, so src+logo on
gpt-image-2 drops the logo. Gemini 3 / Runway iterate.
Hermes `_prepare_fal_request` L365 raises. Not A-006.

Cycle 170: **Default comment is the capability table.**
L492–494. `getImageApiDefaultModel` returns undefined so
this assignment is the unspecified path. Q-003 mapper
does not have to change it. Not A-006.

Cycle 171: **Azure edit download is not the helper.**
L654 vs L816. No 30s timeout; only the 8 min
`withTimeout` (longer than MCP 5 min mcpFetch). ENG-933
already rasterises persisted logos. Not A-006.

Cycle 172: **Azure FormData always `image/png`.** L660–
662. Gemini `inlineData.mimeType`; Runway data-URL
prefix. Same silent-lie class as cycle 169 `[0]`. Not
A-006.

Cycle 173: **S3 persist always `image/png`.** L582–587
literal. Gemini 3 L1319–1320 is the only vendor path
that puts MIME on the data URL; `split(',')[1]`
throws it away. C2PA L116–124 `sharp().png()` makes the
successful strip honest; `removeC2PA: false` or strip
fail can lie. `ImageGenerationResult` has no `mimeType`.
Not A-006.

Cycle 174: **Runway HTTPS skips C2PA and S3.** L570–572
`return result` before L575. Meter L551 already fired.
Tests pin `https://runway.com/image.png`. Emma
`remove_c2pa_from_image` downloads HTTP; MCP grep empty.
Not A-006.

Cycle 175: **`generateWithOpenAI` else is unreachable.**
L533–534. All eight `SUPPORTED_MODELS` ids dispatch
earlier. `getOpenAIClient` L4/L1454 and `getApiKey`
OpenAI else L371–375 are the same dead path. Meter
comment L549 still names it. Not A-006.

Cycle 176: **Meter `provider` is a prefix.** L554–558
`startsWith("gpt-image")` → openai though dispatch is
Azure; `startsWith("gemini-")` misses Runway’s
`gemini_2.5_flash` (underscore) so that id is runway.
Dollars are `imageGenerationCostUsd(model)`. Video
`isHiggsfieldModel` (L37 / L1101) is catalog membership.
Not A-006.

Cycle 177: **`BLOG_SETUP.md` is a stale fifth catalog.**
L9 / L46–67 still name GPT Image 1 + DALL-E 3 + Picsum
and `OpenAI/Image`. `generateBlogImage` (`blog.ts`
L648–655) and the HTTP route (L1431–1438) omit
`imageModel`, so L492 Gemini 3 fires and `isAvailable()`
L1541 probes `Google/Image`. Backend grep of Picsum /
DALL-E / `OPENAI_IMAGE_API_KEY` / `blog-images/` is
empty. Fallback log L1559 still says OpenAI. Agent-engine
`web_agent.py` L3296–3299 is a **live** OpenAI else on
the GCP worker (`secrets_manager.py` L199–200). A-012
already parks lifting the controller import. Not A-006.

Cycle 178: **Two deploy units, two image dispatch tables.**
Python named branches L3249–3301: FLUX / gemini-2.5 /
gpt-image-1 / else OpenAI. Leaf `SUPPORTED_MODELS` has
gpt-image-2, Gemini 3, Runway — not FLUX or
`openai-image-1`. Unspecified Emma → Gemini 3;
unspecified task (`task_monitor.py` L1242) →
`openai-image-1`. A task storing `gpt-image-2` hits
OpenAI else on the worker and Azure on the leaf. CLI
help L4216 names only two ids. Q-003 already parks
`image-models.ts` L11. Not A-006.

Cycle 179: **Admin seed omits Azure `gpt-image-1`.**
`ImageModelsSettings.tsx` L71–89. `fetchConfig` L129–131
writes that list when Dynamo is empty. Grep of the file
for `gpt-image-1` is empty. `imageModelService.ts` L22 /
L83 same fallback. Worker named branch L3281 is
unadvertised. Not A-006.

Cycle 180: **Onboarding pins Gemini 3.** L84 / L493
always set `imageModel`, so L492 unspecified (Q-003)
never runs. Brief item 4 also skips `logoImage`.
`convertSizeToAspectRatio` maps 1080x1080 → 1:1 and
1080x1350 → 4:5 (L1148 / L1157). Azure t2i L712 passes
`size` raw. Three hardcoded defaults, no shared
constant. Not A-006.

Cycle 181: **Onboarding 180s race does not abort the
8 min leaf.** Nested `Promise.race` (`generateWithTimeout`
L487 vs `withTimeout` L89). `AdImageGeneratorDep` has no
signal. Meter L551 after inner success; S3 L564; UI
already `placeholder://` (L676). Test L375–408 blesses
elapsed < 2s, not cancel. Three parallel variants
(L663). Cycle 104’s MCP 5 min hop is the same hole.
Not A-006.

Cycle 182: **Late Gemini success S3-uploads a key
nobody stores.** Cycle 180 pins Gemini 3 data URLs, so
L566–587 runs (not L570 HTTPS skip). Key
`users/${userId}/files/${Date.now()}/{token}/ad-image-…`
(`s3Utils.ts` L264). Metadata `uploaded-by: agent-mode`
(L276). Grep DeleteObject empty. ENG-792 L1100–1111
fails only all-placeholder. C2PA L575 still strips the
discarded buffer. Not A-006.

Cycle 183: **`uploaded-by` is a hardcoded `agent-mode`
constant.** Both helpers (L276 / L352); signature
L230–235 has no caller tag. Thumbnail writer
(`workPlanThumbnailService.ts` L37) stamps
`workplan-thumbnails` on its own S3 client. Grep of
`backend/` is those three lines. Screenshots wrap
the helper (L397) and inherit the lie. Tests never pin
the metadata. Not A-006.

Cycle 184: **`uploaded-by` is write-only.**
`getS3ObjectMetadata` callers read `ContentType` /
`ContentLength` (`agentModeService.ts` L28645,
`filesController.ts` L39 / L307). `assetController.ts`
L3 imports the helper unused; L117 HEADs with a
second client for MIME. Helpers have zero `Tagging`.
Hermes MEDIA tags are read by the gateway. Not A-006.

Cycle 185: **Helpers omit `CacheControl`.** PutObject
params L269–279 / L345–355 have no CacheControl.
`filesController.ts` L379 (HTML form save) is the
README subject. README L1537 / L1553 / L1577 / L1682
assume origin `max-age=60`. Thumbnail L35 is the
only S3 `CacheControl`. `serveAsset` L124 hardcodes
300s on HTTP. Glob `**/*cloudfront*` empty. Not A-006.

Cycle 186: **`serveAsset` hardcodes `max-age=300`.**
HEAD L117 then L124 overwrite. Email
`rewriteS3ImageUrls` (L187) is the live hop
(`dripSequenceWorker.ts` L187, `sequences.ts` L353).
`app.ts` L506 is public. Work-plan thumbs use raw S3
URL (`WorkPlans.tsx` L824). `filesController` stream
sets no Cache-Control. Tests never import `serveAsset`.
Not A-006.

Cycle 187: **Rewrite matches one S3 host; `/asset/`
accepts three.** `S3_BUCKET_HOST` L178 vs
`extractS3KeyFromUrl` + `ALLOWED_BUCKETS` (user-files
+ execution-gifs). Brand L71–80 already documents the
hardcoded-prefix lie and L84 matches on bucket.
Rewrite tests never use the region-less URL L10
pins. Not A-006.

Cycle 188: **Three S3 URL writers.** Helpers return
`result.Location` (`s3Utils.ts` L285 / L361;
thumbs L42). Tests mock global path-style
(`s3Utils.test.ts` L53). Brand L60–64, `db.ts`
L3006, `tasks.ts` L1153 / L1333,
`reportRevisionService.ts` L477, `agentModeService.ts`
L30469 / L30619 construct regional virtual-hosted.
`books.ts` L47 encodes segments. Remotion L204 is
`s3.${region}.amazonaws.com/${bucket}/…` (test L57).
Zero `s3ForcePathStyle`. CORS L224 allowlists Family
B’s host only. Image persist is Family A
(`imageGeneration.ts` L582–593). Not A-006.

Cycle 189: **Family B is not one function.** Books
L43–47 / L1810–1814 encode each segment; brand
L47–62 interpolates `originalname` into both Key
and URL. Helpers sanitize first (`s3Utils.ts`
L248–265; test L91). `deriveOwnBucketKey` L97
decodes; `extractS3KeyFromUrl` L27 does not —
`filesController.ts` L36 HEADs the encoded string.
No books test pins `encodedKey`. Not A-006.

Cycle 190: **CORS Origin is exact Family B host.**
`app.ts` L224 string vs regexes; L256 `origin ===`;
L293 `credentials: true`. `cors.test.ts` pins
hireemma/ngrok, grep s3 empty. CloudFront forms
already match L220 `*.agentwebforms.com`. Repair
`includes('agentweb-user-files.s3')` (L30399)
is wider; path-style Location Origin misses both.
Not A-006.

Cycle 191: **HTML repair is a third matcher.**
Five `includes('agentweb-user-files.s3')` in
`repairBlogArticle` (L30399 / L30407 / L30415 /
L30420 / L30428). Hardcoded prod bucket, not
`AWS_S3_BUCKET`. Same class already
`extractS3KeyFromUrl` + `getS3ObjectStream`
(L28635; comment: private objects). Same method
writes Family B with env bucket (L30469 /
L30619). Tests set `test-bucket` and never pin
`totalImagesChecked`. Path-style that
`s3Utils.test.ts` L340 pins still misses. Callers:
Emma `repair_blog_article` L2775, `POST
/repair-blog` L887. Not A-006.

Cycle 192: **Repair `axios.get`s S3.** Article
L30316 (no host check) and images L30547 (comment
says “from S3”). Same class already Path A SDK
(`read_file_content` L28631) and Path B presign
(`describe_image` L9327; LinkedIn MEDIA L38291).
`filesController.ts` L35: no public access needed.
`db.ts` L2994 no ACL. Gemini L9304: some URLs are
fetchable. Path C is the private-object miss.
Tests mock axios. Siblings: `removeC2PAFromImage`
L29538, `removeImageBackground` L29660. Not A-006.

Cycle 193: **Emma C2PA/background advertise S3.**
Schema L4936 / L4969. Data URL skips axios. C2PA
test L143–163 pins `axios.get` of path-style
`s3.amazonaws.com/bucket/…`. Write `uploadFileToS3`
L29585 / L29705. REST `POST /remove-c2pa` L216
metered; no emmaApi for background. MCP grep empty.
Axios shape = `processInputImage` L816. Not A-006.

Cycle 194: **Leaf `processInputImage` is Path C.**
L816–823, no presign, no data: skip. Gemini L929 /
L1024 / L1240; Runway L1371 skips data. `logoImage`
push L477 then L492 Gemini 3. ENG-792 onboarding
L707 / `classifyBrandLogoUrl` L478. Tests mock
axios for `example.com`; Runway pins data URL.
Q-014 listing still ready. Not A-006.

Cycle 195: **Video `processInputImage` is a second
Path C.** L236–253: 30s axios, no UA, no SVG, MIME
header or `image/png`. Only Veo start/end (L393 /
L418). Default `seedance-2.0` (L46) is Higgsfield
`media_import_url` (L827–838) — vendor fetches.
Fallback L994–1000 re-enters `generateVideo` with
the same frames. Tests pin Higgsfield import;
spy Veo on fallback. Q-016 parked. Not A-006.

Cycle 196: **`generateKeyframes` persist-then-Path-C
is Veo-only.** L851–897 calls `imageService.generateImage`
with no `imageModel` (Gemini 3). L1032 feeds those
Family A URLs into Veo Path C. `useKeyframes` is
read only inside the Veo multi-clip branch. Seedance
ignores it; fallback L1000 can suddenly bill N+1
images. Tests grep empty. REST omits the flag.
Q-016 parked. Not A-006.

Cycle 197: **Character `referenceImageUrl` is Path D
on the Seedance default.** Emma `create_character`
L5436 requires the `generate_image` S3 URL; L5385
pass as `startFrame`. `media_import_url` L827 vendor-
fetches. Execute L5451 `referenceImageKey: ''`. REST
upload L51 stores the key. MCP grep empty. Tests pin
`example.com`. Q-016 parked. Not A-006.

Cycle 198: **Brand-guide matcher misses Family A.**
L15132 `includes('.s3.')` is Family B only.
`s3.amazonaws.com` Location (test L53) stamps
`filename: 'url'`. REST file upload L60–62 is Family
B so it hits. `deriveOwnBucketKey` L109 already
parses path-style. Occupied `agentModeService.ts`.
Not A-006.

Cycle 199: **Auto-pin persist is Family A; fake key
blocks delete.** `downloadBrandLogoToS3` L425
returns Location only. Helper L361 also has
`result.Key`. Three mints stamp `auto-logo-*`.
Delete L693 prefers stored key. REST L64 stores
the real key. Skip-re-pin L15242 uses real
`isS3Url` (hits A). Occupied `agentModeService.ts`.
Not A-006.

Cycle 200: **ENG-792 probe is Path C of own-bucket
Family A.** `classifyBrandLogoUrl` L492 axios GET;
`brandLogo.ts` has no `isS3Url`. Ads
`isBrandLogoFetchable` fail closed on 4xx.
`filesController` L35 already SDK-streams. Tests
inject `https://s3/logo.png`. Not A-006.

Cycle 201: **Pin GET has no User-Agent.** L374–377
no headers; test L243–246 pins that. Probe L495
Mozilla; cssExtractor L131 Extractor/1.0. Pin-fail
+ probe-success leaves the external host as source
of truth. Not A-006.

Cycle 202: **Pin skips ssrfGuard.** brandLogo.ts
grep empty. cssExtractor validateURL L142 is
module-private and company-URL-only. describe_image
L9363 already uses fetchBufferFollowingRedirects.
Emma logoUrl is a free string (L2063). Not A-006.

Cycle 203: **Company-scrape validateURL misses
FORBIDDEN_HOSTNAMES / DNS-pin.** Tests L298-311
pin localhost/10/192.168/ftp. Preferred path is
page.goto L559 after the string check. Axios HTML
fetch omits maxRedirects:0. webContentFetcher is a
third local copy that does DNS+169.254. Not A-006.

Cycle 204: **Preferred scrape spoofs Mac Chrome/120.**
page.setUserAgent L546; axios fallback L131 is
Extractor/1.0. Tests L620 pin no-cache headers,
not the UA. LinkedIn L608 is Chrome/131. Not A-006.

Cycle 205: **read_brand_guidelines shows filename.**
L27884 Primary Logo: asset.filename. Update ack
L27940 no href. formatCSSExtractionResult L15631
already prints logoUrl. generate_image L4999
asks for the URL. MCP does not list this tool.
Not A-006.

Cycle 206: **Pin/probe omit Referer.** Chrome
scrape still sends it on <img>/icon during
networkidle2. Pin L374 no headers (test L243).
Probe L495 Mozilla only. Referer-gated CDN
403s both after scrape found the URL. Ads fail
closed. Occupied app.ts #2271. Not A-006.

Cycle 207: **generate_image.filename is the
output name.** Required with prompt+category
(MCP L2093 / Emma L5052). Leaf L1526 non-empty
only. Cycle 205's asset.filename (logo.png /
'url') is a different contract. logo_image
optional; ENG-326 recovers omit. Hermes native
schema requires prompt only. Not A-006.

Cycle 208: **Work-plan continue de-dupes on
filename.** extractGeneratedImageFilenames
L5889; test L268–274 pins a.png twice → one.
Awareness L5909 lists that length. Persist
marker de-dupes assets by URL (L29093). S3
keys unique per upload. Not A-006.

Cycle 209: **Reprioritize.** Product Q-014 →
Q-004 → Q-001 → Q-003. Architecture A-002 →
A-019 → A-007 → A-008. A-019 unparks because
CallTool is still untracked (mcpServerCore.ts
L88–120) after Q-014 will bill images on this
PORT. A-008 persist (one URL handle) waits on
the pile. Not A-006.

Cycle 210: **track() cannot refuse.** Callers
pass an already-started Promise (server.ts
L301). Worker refuse is inside runInWorker
L443. tryClaim false is 409 SESSION_BUSY
(L9016). Q-014 generate_image never tryClaims.
CallTool handler-entry isError, then wrap
execute in track() for the wait. Not A-006.

Cycle 211: **Do not drain-gate ListTools.**
POST `/mcp` (mcpServer.ts L298) has zero
`isCronEnabled`. ListTools is ungated
`getToolDefinitions()` (L81–83). initialize
still `sessions.set` + Dynamo persist
(L336–359) so ENG-114 rehydrate can serve a
retry on the new instance. HTTP 503 only
when the body contains `tools/call` (copy
anonymousTransport.ts L68–83). JSON-RPC
`isError` is HTTP 200 — Hermes fixture L84
asserts 200; SDK 404=reinit vs 400 terminal
(`mcp.mcpServer.test.ts` L243–249). Wrap
CallTool in `track()` for the wait. Not A-006.

Cycle 212: **Do not 503 GET `/mcp`.**
SDK `_startOrAuthSse` throws
`StreamableHTTPError` on GET 503;
405 returns and keeps POST
(`streamableHttp.js` L100–103). Q-001
fixture never GET. GET is local-Map
only (L516); no rehydrate. `setTimeout(0)`
still loses to nginx 600s. Existing SSE:
`runDrain` still `server.close` without
`mcpShutdown`. Not A-006.

Cycle 213: **`mcpShutdown` after the wait
belongs in A-019 first_slice.**
`runDrain` never calls it (`server.ts`
L440). Sibling `process.on` (`mcpServer.ts`
L269–270) registers first (`app.ts` L204
via `server.ts` L2). Sunday SIGTERM
`transport.close()`s the shared
`StreamableHTTPServerTransport` (POST
L313 + GET L530) before the wait. ASG
`drainForShutdown` is before any SIGTERM
(`asgLifecycleGuard.ts` L18–21) so
without a `runDrain` call the closer never
runs. Do not `sessionStore.delete` (cycle
94). Not A-006.

Cycle 214: **GET cleanup is
`streamController.close()`.** Vendored
`close()` (`webStandardStreamableHttp.js`
L604–613) is sync `forEach(cleanup)`.
Hono `flow({done})` then `writable.end()`
(`@hono/node-server` `index.mjs` L287–288).
`close()` does not await that end; Node
`server.close` still waits for the
connection. Do not await `server.close`
for the hang. Local never
`enableJsonResponse` (only rehydrate L90).
Not A-006.

Cycle 215: **Rehydrate CallTool is the
wrap, not `mcpShutdown`.**
`rehydrateAndServe` builds a JSON
transport (`mcpSessionRehydration.ts`
L88–90) and `close()`s it in `finally`
(L115–118). Never `sessions.set`. JSON
`cleanup` does not `resolveJson`
(`webStandardStreamableHttp.js`
L458–460 / L696–706). Closing it
mid-CallTool hangs `handleRequest`.
POST 503 at L298 is before the
rehydrate branch (L439). Not A-006.

Cycle 216: **Keep rehydrate
`finally close()`.** JSON
`resolveJson` (L706) never
`stream.cleanup()`; SSE else
(L712–714) does. After
`handleRequest` returns, `close()`
is delete-only leftover
`_streamMapping` (initialize +
CallTool) and cannot hang. Skipping
it after resolved JSON does not
leak Express (`writeWebResponse`
`res.end`). JSON on a reused
transport would accumulate one
entry per POST — do not
`enableJsonResponse` on the live
Map. Not A-006.

Cycle 217: **`mcpShutdown` never
cancels `generate_image`.**
`_onclose` does not abort
`_requestHandlerAbortControllers`.
Only `notifications/cancelled`
does (`protocol.js` L169–175).
CallTool is `async (request) =>`
(`mcpServerCore.ts` L88) — no
`extra`. mcpFetch abort is a
5 min timer (`httpClient.ts`
L204–208). `emmaApi` generate-image
has no `req.on('close')`. Loopback
is a different socket. The wait is
the billed hop. Not A-006.

Cycle 218: **`send()` after `close()`
is Protocol `_onerror`, not
`isError`.** `_onrequest` awaits
the handler then `send()`s
(`protocol.js` L350–370). CallTool
**returns** `{ isError }`
(`mcpServerCore.ts` L164–174) so
Protocol takes the success `.then`.
`close()` clears `_streamMapping`
not `_requestToStreamMapping`
(L604–613); `send()` then throws
`No connection established` (L694)
into L398 `_onerror`. `drain()`
polls `inFlight.size` every 2s
(`cronJobRegistry.ts` L62–70) and
does not await `send()`. Wrap the
handler return, not only `execute`.
Not A-006.

Cycle 219: **Closed POST SSE is not
404 reinit.** SDK `send()` POST
uses `_handleSseStream(..., false)`
(`streamableHttp.js` L390).
Reconnect needs priming `id`;
`writePrimingEvent` returns without
`eventStore` (L157–160). `mcp/` has
zero `eventStore`. 404 is a later
POST after `sessions.clear()`
(`mcpServer.ts` L448–460). Q-001
fixture is httpx `next(data:)`
(L81–86), protocol `2025-06-18`.
Not A-006.

Cycle 220: **60s is client
`Protocol.request()`, not inbound
CallTool.** `DEFAULT_REQUEST_TIMEOUT_MSEC`
60000 (`protocol.js` L8 / L691).
`mcpServerCore` handler has zero
timeout. AgentWeb as client uses
3600000 (`mcpClientService.ts`
L1670). Q-001 fixture is httpx;
Hermes 315s is OAuth add
(`HERMES_MCP_OAUTH.md` L21–36).
Default SDK `callTool()` would
abandon `generate_image` at 60s
while mcpFetch+leaf still bill.
Not A-006.

Cycle 221: **`notifications/cancelled`
is a new POST, not the CallTool
SSE.** Client `send()` always
POSTs (`streamableHttp.js`
L288–305) and ignores
`relatedRequestId` (a server-send
option, `transport.d.ts` L22–24).
Notification POSTs 202
(`webStandardStreamableHttp.js`
L434–441). After `mcpShutdown`
`sessions.clear()` the next POST
rehydrates a new Protocol or 404s
and cannot `_oncancel` the
original. During the wait, copy
`method === 'tools/call'` so
cancelled is not 503. Protocol
L351 then skips `send()` if
cancelled did land. Not A-006.

Cycle 222: **skip-send does not
`stream.cleanup()`.** Cleanup is
only `send()` L712–714 after a
JSON-RPC result/error. Aborted
`_onrequest` `return`s without
`send()`; `_requestToStreamMapping`
stays. Local POST already returned
200 SSE. `mcpShutdown` `close()`
is the hang closer for GET **and**
that orphaned POST (same
`streamController.close()`).
`extra.closeSSEStream` is unset
(no `eventStore`). Not A-006.

Cycle 223: **skip-send POST is the
same ASG cut as GET.**
`mcpShutdown` `forEach(cleanup)`
starts Hono `writable.end()`
(later tick). `runDrain`
`server.close` is a callback
(`server.ts` L440). The hook
`completeAction`s after drain
resolve (`asgLifecycleGuard.ts`
L262–273). Do not await
`server.close`. Not A-006.

Cycle 224: **Sunday `process.exit(0)`
cuts Hono end I/O; ASG does not
exit.** After A-019, skip-send idle
POST is Hono `reader.read().then(flow)`
(`index.mjs` L272) so `writable.end()`
is usually a microtask during
`mcpShutdown`. `end()` is not joined.
Sunday then `process.exit(0)`
(`server.ts` L466–471). Node types
(`process.d.ts` L869–871) force-exit
pending I/O. ASG `completeAction`
(L268–273) leaves the process
alive. If `flow` is on `'drain'`
(L289–290), Sunday can cut *before*
`end()`. Do not put `process.exit`
on the ASG path. Do not replace
Sunday exit with `exitCode` in
A-019. Not A-006.

Cycle 225: **SIGTERM on a settled
`drainPromise` can exit before
`completeAction`.** Memoization is
drain only (`server.ts` L368–370).
`gracefulShutdown` then
`process.exit(0)` (L466–471).
CONTINUE is after
`onTerminating` (`asgLifecycleGuard.ts`
L262–273) and starts at
`await readInstanceId` (IMDS HTTP).
HeartbeatTimeout 900s CONTINUE
(`eb-deploy.sh` L612) is the
fail-safe. Tests pin drain-then-
complete in one tick and never
inject SIGTERM. Do not await the
hook from A-019. Not A-006.

Cycle 226: **`Terminating:Wait`
does not pin SIGTERM withheld.**
L18–19 is IMDS-vs-instance-stop
order as a comment. Tests never
inject SIGTERM.
`workerShutdownGuards.ts` L1–9
and `dev.md` L1853 name cgroup
SIGTERM on deploy / ASG
replacement / health-check
restart. Only replacement is
`EC2_INSTANCE_TERMINATING`. No
Node `TimeoutStopSec` in git
(cycle 116). Do not treat L18–19
as a pin that cycle 225 cannot
happen with the hook. Not A-006.

Cycle 227: **`IgnoreHealthCheck:
false` is not a Wait SIGTERM.**
`rolling.config` L2–4 is
`aws:elasticbeanstalk:command`
(Immutable deploy). After A-019
unawaited `server.close`, nginx
502s `/health` (cycle 107) while
`completeAction` can still run
(cycle 223). That is not
`process.exit(0)`.
`04-disk-alarm.config` names 4xx
rules, not `/health`. Do not 503
`/health` during the wait. Not
A-006.

Cycle 230: **A-019 `tools/call` 503
is not a Wait replace.** AWS
enhanced-health rules can only
customize 4xx; 5xx cannot be
ignored. Zero `HealthCheckType`
in git. ALB target stays `/` and
`/health` 200 until close
(`app.ts` L547–553). Copy
`runScheduledChats` 503. Do not
set `HealthCheckType: ELB`. Not
A-006.

Cycle 231: **dying-instance 5xx
does not fail the new Immutable
instance.** `HealthCheckSuccessThreshold`
unset (default `Ok`) is the
temporary ASG bar
(`rolling.config` has no
threshold). ENG-878 Red is after
the old row is gone. Not A-006.

Cycle 232: **Sunday
`InstanceRefreshEnabled` is
weekly Immutable, not rolling.**
AWS managed-updates page, not
the L4–6 comment. Zero
`RollingUpdateType` in this tree.
New weekly instances take the
same `Ok` bar as merge Immutable
(cycle 231). Sunday still never
calls `eb-deploy.sh` (cycle 110).
Park A-020. Not A-006.

Cycle 233: **Sunday-without-hook still
`disableCron`s.** IMDS `Terminated`
and SIGTERM `gracefulShutdown` both
start `runDrain` (`server.ts` L387
first). Wait is the park. TODAY
sibling closer 502s `/mcp` first
(cycle 213). Not A-006.

Cycle 234: **Hermes can see A-019 503
while `/health` stays 200.** Nginx
502 is after `server.close`. 600s
DeregistrationDelay starts at
deregister. Do not 503 `/health`.
Not A-006.

Cycle 235: **A-019 POST `/mcp` 503 is
a one-shot in this tree.** Q-001
fixture asserts 200. SDK `send()`
throws; only 401 recurses. Not A-006.

Cycle 236: **HTTP 503 does not poison
`transport.sessionId`.** Only DELETE
`terminateSession` clears it. Later
`tools/call` can rehydrate. Do not
404 drain. Not A-006.

Cycle 237: **JSON 503 is enough for
SDK `send()`.** Content-Type is only
read after `ok`. SSE 503 still
throws. Do not emit event-stream
drain. Not A-006.

Cycle 238: **this tree cannot rewrite
JSON 503.** Zero `error_page` in
`.platform`. Unvendored intercept is
live-AWS-only. Do not add
`error_page`. Not A-006.

Cycle 239: **ALB passes Application 503
through.** Zero listener rules. AWS
502 is TCP RST / malformed / target
gone, not a rewrite of Node JSON 503.
Do not add `aws:elbv2:listener`. Not
A-006.

Cycle 240: **A-019 does not pin ALB XFF
attributes.** AWS defaults. Not an EB
option. MCP has zero `req.ip`. ENG-493
/ later ops. Not A-006.

Cycle 241: **XFF pin is
`modify-load-balancer-attributes` on
the LB ARN.** Not the TG loop. Not
A-019. Not A-020. Not A-021. Not A-006.

Cycle 242: **`LoadBalancers[*].Name`
stays.** Console XFF drift survives
Immutable and Sunday. `IdleTimeout`
does not reapply weekly (ENG-836).
Not A-006.

Cycle 243: **a later ENG-493 pin is the
only in-tree reassert of XFF without
recreate.** IdleTimeout’s resource-only
PR does not transfer. Recreate is out
of band. Not A-019. Not A-006.

Cycle 244: **deploy IAM does not list
`ModifyLoadBalancerAttributes`.** Grant
is live-AWS-only. TG modify does not
imply LB modify. Not A-019. Not A-006.

Cycle 245: **`DescribeLoadBalancerAttributes`
is also unnamed.** ENG-823 TG Describe
is used; LB Describe is never called.
Not A-019. Not A-006.

Cycle 246: **an XFF no-op still needs LB
Describe on every opted-in backend
SUCCESS.** ENG-823 skip is after
Describe. Partner unset is the only
zero-call path. Not A-019. Not A-006.

Cycle 247: **a later XFF IAM miss is
GitHub-red / prod-green, not an A-019
503.** SUCCESS is logged before the pin.
No abort. Not A-006.

Cycle 248: **a later XFF pin can fail
closed before `update-environment`.**
Hook slot L655. Copying ENG-823
after-verify is a choice. Not A-019.
Not A-020. Not A-006.

Cycle 249: **fail-closed-before-apply
only helps GitHub merges.** Sunday XFF
drift is IdleTimeout class. Zero
`schedule:` on `deploy.yml`. Not A-019.
Not A-020. Not A-006.

Cycle 250: **a pin-only `schedule:`
would be the git-native Sunday XFF
reassert.** It does not exist. Not
A-019. Not A-006.

Cycle 251: **a pin-only Sunday job would
not hit Must be Ready.** That error is
`UpdateEnvironment`. elbv2 talks to
the surviving ALB during Updating. Not
A-019. Not A-006.

Cycle 252: **XFF must use
`LoadBalancers[*].Name`, not
`AutoScalingGroups[0]`.** Sunday
Updating: two ASGs, one ALB. Not
A-019. Not A-020. Not A-006.

Cycle 253: **this tree and AWS
immutable do not return two
`LoadBalancers[*]` ARNs during
Updating.** Tests fixture one ARN.
SharedLoadBalancer unused. Not
A-019. Not A-020. Not A-006.

Cycle 254: **if two ARNs appeared,
copy ENG-823 pin-all.** Do not fail
closed on `count != 1`. Do not take
`[0]`. Not A-019. Not A-020. Not
A-006.

Cycle 255: **do not fork `grep '^arn:'`
into an `/app/` filter from A-019.**
XFF keys are ALB-only; ENG-823 TG
delay is not. Not A-019. Not A-020.
Not A-006.

Cycle 256: **a `net/` XFF modify fails
the job.** Do not add skip-non-app.
`fail()` exits 1. Not A-019. Not
A-020. Not A-006.

Cycle 257: **NLB `xff_*` Describe is
`None`, then Modify, then fail.** Skip
is only `current = desired`. Not A-019.
Not A-020. Not A-006.

Cycle 258: **do not `fail()` on ALB XFF
Describe `None` before Modify.** ENG-823
has no pre-Modify value gate. Hook
None-fail is the wrong object. Not A-019.
Not A-020. Not A-006.

Quota is **not** in `generateImage` (cycle 40). MCP’s HTTP hop skipped
the controller gate, so ENG-973 attached `requireEmmaTokenBudget` at
`emmaApi.ts` L16–21. `POST /generate-image` is `metered`
(`emmaTokenBudget.ts` L58). In-app chat checks `checkTokenUsage` in
`chatbot.ts` L156. Media auto-continuation had to copy it again
(`agentModeController.ts` L1327–1334) after bypassing
`generateSessionResponse`. A fifth process would need a fourth copy.

In-app Emma does **not** use MCP for this tool (cycle 26):

```
toolDispatch.ts L930–936
    ports.executeAgentToolThroughGateway
    execute: () => ports.executePreparedAgentTool(...)
    ▼
agentModeService.executePreparedAgentTool  L8773
    ▼
this.executeTool(...)  L8804   ← same generateImage policy, no HTTP
```

Two inbound faces, one policy method. Hermes has one in-process tool
table plus MCP *outbound*.

Cycle 30: **leaf callers skip the policy method** and still must stay
in-process with the meter: `controllers/blog.ts` L648,
`workPlanThumbnailService.ts` L98, `videoGeneration.ts` L875,
`onboardingAdImageService.ts` L494 (`logoImage` into the leaf). An HTTP
mesh in front of `emmaApi` would not see them. C2PA default-on and
CRITICAL LOGO already run in `imageGeneration.ts` for those callers
(cycle 36). A-008 re-export does.

`emmaApi.ts` has **59** `getAgentModeService()` calls. The REST surface
already looks like logical nanoservices; almost every route funnels into
the god object. `/email` is a rare exception (`emailProviderService`).

## Coding agent (cycle 26)

`codingAgentService.ts` (2,387 lines) is **not** a subprocess. It
`mcpFetch`es landing-page files (loopback) and imports `agentModeService`
only to ignore `context.llmModel` (already set at `emma/tools.ts` L7582)
in favor of `getCodingAgentDefaultModel()`. A-010: drop that import; do
not extract a fifth deploy unit.

## Fourth deploy unit: agent-engine (cycle 27)

This is the Microsoft “extract when isolation forces it” case:
Playwright + conda cannot share the Node/EB process. Work arrives via
Dynamo (`get_pending_executions`, `StatusStartTimeIndex`, status
`pending` — `task_monitor.py` L253–274). Metering and revisions do **not**
stay in Python: `create_jwt_token` (`task_utils.py` L84) + `requests.post`
to `BACKEND_URL` (`usage_reporter.py` L258 `/api/internal/usage`;
`task_monitor.py` L129 revision). Same JWT self-call as MCP `mcpFetch`,
cross-process. `#361` is an open engine PR (browser-use); do not land
architecture edits there.

`remotion-lambda` is the other extract (Chromium/ffmpeg), invoked
in-process from `remotionService.ts` via `renderMediaOnLambda` L467 —
not a second Emma mesh. Cycle 55: `recordVendorUsage` stays in that
host adapter with `params.userId`. `LoopPorts` has no remotion.
`imageGeneration.ts` is the same shape (vendor HTTP + in-process
meter). Do not copy the **Lambda process** onto images.

## MCP client + server (cycle 29)

Hermes: MCP **client** to other servers; tools stay in-process.

AgentWeb: MCP **server** (`mcp/server`, loopback `mcpFetch`) *and* MCP
**client** (`mcp/client/mcpClientService.ts`) to GitHub/Playwright/Higgsfield.
`mcp_config.ts` L3–10 still names `"agentweb-tools"` → `http://localhost/mcp`.
`initialize()` L420–432 **skips `isInternal` on file config only** so Emma
does not MCP-call herself from `mcp_config.ts`. Cycle 90: the Dynamo
`mcp_servers` path (L435–450) has no that filter; `this.clients.has`
cannot see skipped names; tests (`mcp.mcpClientService.test.ts`
L1041–1048) connect `isInternal: true` via DB on purpose. Admin
`isValidUrl` (`mcpServers.ts` L87–90) allows localhost; the partner
tab has no `isInternal` Switch (default false) but a URL field.
`syncMcpAndRecycleWorker` (L64–82) reloads parent + worker onto that
row. That skip is still the in-tree rejection of A-006 — incomplete,
not a reason to HTTP-split. Park A-018. Cycle 56: the
folders already encode it — prod `mcp/client` ↛ `mcp/server` and reverse.
Shared `mcp/anonymousToolAccess.ts` only (ENG-822). Do not HTTP-split
that DAG; park A-016 until A-002. Vendor MCP
(`excludeFromAgent`, Higgsfield) stays; do not invent a fifth process for
image gen.

Cycle 34: `httpClient.ts` L63 `lookupUser` → `await import('../../services/db')`.
A-007 `tools/infrastructure.ts` still mcpFetchs through that client.
File split ≠ `loops/core` package. Do not forbid db in `mcp/server`.

Cycle 35: in-process composition root is `app.ts` L118–120 (explicit
instance `register*`), not `loops/index.ts` (Hermes registry: types only).
Cycle 57: that root also does `setupMcpServer` L204 and `setupMcpOAuth`
L343. **#2271** +7 on the Express route table (WhatsApp). A-007 still
attaches at `mcpServerCore.ts` L26, not `app.ts`.
`mcp/server/registry.ts` L1 already imports `evaluationPolicy` — do not
demand loops-index purity of the MCP registry.

## Four in-process registries (cycle 37)

Hermes: one `registry.py`. AgentWeb already composes four tables without
HTTP:

```
mcpToolRegistry        ← apiTools / workflowTools / evaluationTools
emmaToolRegistry        ← emma/tools.ts (3-line emma/registry.ts)
mcpClientService tools  ← vendor MCP (Hermes-shaped client)
this.toolRegistry       ← copies both (L1827 vendor, L1891 Emma)
```

`ListToolsRequestSchema` (`mcpServerCore.ts` L81–83) is Q-014’s face.
Do not dual-register `generate_image` like `evaluation_workspace` (L62).

## Two `generate_image` executes (cycle 38)

```
emma/tools.ts L5055–5075  ──► agentModeService.generateImage  (policy, in-process)
apiTools.ts L2096–2107    ──► mcpFetch POST /api/emma/generate-image
                              ──► same generateImage (already the HTTP face)
```

Q-014 lists the second row. A-006 would add a third hop after it.
`backend/package.json`: no `workspaces`, no dependency-cruiser.

Cycle 46: there is a **third execute on the parent** that is neither
row: Emma chatbot `chatbotService.ts` L5461 `executeTool` (in-process,
no fork, no mcpFetch). Three faces, one policy method, two OS processes.

## Three catalogs (cycle 47)

Hermes: one `tools/list`. AgentWeb’s three faces do **not** share a
catalog:

| Face | Catalog |
|---|---|
| MCP | `internal: true` at `apiTools.ts` L2077; `getToolDefinitions()` L82–84 |
| Chatbot | `pageToolMap['images']` includes `generate_image` (`chatbotService.ts` L5211) on top of `buildSkillContext` |
| Agent Mode | `FOUNDATION_TOOLS` + skills + `__other_skills__`. `generate_image` is **not** foundation. `describe_image` **is** (ENG-260 L6166–6171). `get_visual_context` is the page-only exclusion (`getUnassociatedTools` L6375–6376) |

Q-014 flips the MCP row only. A-014 parks copying the other two
catalogs onto that list. A-006 would have to pick one policy or
reimplement all three.

Cycle 48: the live Hermes handler is **not** a fourth catalog.
`mcpServerCore.ts` L76–83 `ListToolsRequestSchema` returns
`getToolDefinitions()` and says “ALL clients now see all tools (no
skill-gating).” Header L7–8: “No skill-gating for external clients.”
Q-014’s `internal` drop is therefore the whole MCP catalog change.
Fork [kvnloo#2](https://github.com/kvnloo/agentweb/pull/2) owns that
flag; do not open a second listing PR.

Cycle 49: **anonymous may list, cannot run.** When
`MCP_ANONYMOUS_DISCOVERY=true` (`anonymousTransport.ts` L30–34, default
OFF), `tools/list` is in `ANONYMOUS_METHODS` (L41–46).
`ANONYMOUS_TOOLS` is an **empty Set** (L48–58) — Harsha 2026-08-08,
demo tool not shipped. `mcpServer.ts` L61–65 wires that before any
handler. `generate_image` has no `requiresUserAccount` in `apiTools.ts`;
ENG-822 is not the spend door. Do not add the name to `ANONYMOUS_TOOLS`
(A-015). A fifth HTTP image process would need a copy of this allowlist.

Cycle 50: **if CallTool leaked past that allowlist, the hop still dies
in-process.** `mcpFetch` L169 `lookupUser` (`httpClient.ts` L57–66)
throws `User not found: anon_*` before `generateSelfCallToken`. No POST
to `emmaApi`. ENG-822 (`registry.ts` L136) does not fire — the tool has
no `requiresUserAccount` — so the visitor would see the database error
ENG-822 was written to hide, not a picture. That is UX, not spend.
Do not treat `requireEmmaTokenBudget` as the third fail on this path
(the request never arrives).

Cycle 51: **the Emma meter allow-lists `anon_*`.** `auth.ts` L155–167
trusts `_svc` claims with no user row. `checkTokenUsage` L293–305
returns `allowed` while ChatSessions `totalCost` is under **$2**
(`ANONYMOUS_SESSION_COST_CAP_USD` L182). MCP image calls do not create
those sessions, so `costUsed` stays 0. `imageGeneration.ts` L551
`void meterUserUsage`; `incrementUserTokenUsage` L567–570 is `no_user`.
If A-006 copied “the metered route” and skipped `lookupUser`, vendor
spend would be uncapped. Identity stays in the host (`httpClient.ts`).

Cycle 53: **MCP `generate_image` cannot take the ENG-1596 skip.**
Execute is `ctx(context)` (`apiTools.ts` L2096–2098). `ctx()`
(`toolHelpers.ts` L10–22) does not forward `overrideToken`.
`resolveClientScopedContext` is admin-only and used on list/manage
tools, not this one. Chatbot/ishare `$2` is a **different face**
(`executeTool` in-process). A-007 `infrastructure.ts` must keep `ctx()`.

Cycle 54: **do not copy `workflowTools.ts` L37 into that file.**
`emma_get_account_status` (L248) is the mixed-identity tool. The five
infrastructure tools (`apiTools.ts` L2015 / L2044 / L2068 / L2098 /
L2141) are all `ctx()`. OMP `@earendil-works/pi-ai` 0.85.1 still
registers images in-process (`sideEffects` `images.js`).

## MCP schema is thinner (cycle 39)

Hermes one-handler-table vs AgentWeb’s HTTP adapter:

| Contract | In-app Emma | MCP → `emmaApi` |
|---|---|---|
| Schema | `inputImages`, `imageModel`, `confirm`, `metrics_verified` (`emma/tools.ts` L4995–5052) | `input_images`, `image_model`; no confirm / metrics (`apiTools.ts` L2075–2094) |
| `confirm` | passed through to policy | `emmaApi.ts` L181 **`undefined`** — edits always HITL-stop |
| `sessionId` | Emma chat session | `ctx()` has it; `generate_image` body omits it; route uses `session_id \|\| ''` |

Q-014 stays **ready** (list for text-to-image). A-011 parks schema
unification / threading `confirm`. Do not revive A-006 to “fix” the
thinner face.



## Two MCP hop styles (cycle 32)

`mcpServerCore.ts` L26–30 already composes **three** in-process modules
(91 registers). They do not share a hop:

```
workflowTools.ts     ── mcpFetch ──► REST ──► services     (ENG-982; 5 tools)
apiTools infrastructure island ── same hop ──► /api/emma/generate-image
evaluationTools.ts   ── in-process ──► evaluationStore/Service
                     + emmaToolRegistry.register(same handler) L62
```

A-007 `tools/infrastructure.ts` is the workflowTools hop (keep mcpFetch).
evaluationTools is the OMP/Hermes in-process package *already used* for
the eval sandbox. Do not reuse that hop for image gen.

`registry.ts` L22–40: `internal` = hide from `tools/list`; image
generation is named as a cost-driven example (ENG-973 meters the route).
Q-014 is flipping L2077, not a new process.


## What this means

| Move | Extra hop? | Touches policy? |
|---|---|---|
| Q-014 list on MCP | No | No (flag on `apiTools.ts` L2077) |
| A-007 `tools/infrastructure.ts` | No | No (still mcpFetch) |
| A-008 `git mv` + `export *` | No | No (`emmaApi` never imported the leaf; `agentModeService` L28950 keeps resolving) |
| **A-006 HTTP image process** | **Yes** — after L28857 or instead of it | Would split category / HITL / persisted-logo from the leaf (C2PA + meter + CRITICAL LOGO already there). Cycle 46: would also be called from parent chatbot + worker chat |

A-008 is a **path shim**, not `services/swarm/index.ts` (cycle 33: that
barrel has zero prod importers). After `git mv`, `services/imageGeneration.ts`
is `export * from './creative/imageGeneration'`. Closest analog:
`socialPlatformService.ts` L8. **Do not** rewrite `emmaApi.ts`.

## Hermes / OMP vs this hop

- Hermes tools run in-process next to `run_agent.py`; MCP is outbound.
- OMP `pi-ai` is an in-process package; no localhost self-call.
- AgentWeb already paid for an HTTP composition layer (`mcpFetch`) **and
  still** lands in `agentModeService`. Cycle 44: the **chat** path
  additionally `fork`s a child that constructs another `AgentModeService`.
  Cycle 46: that fork is I/O vs compute; chatbot still `executeTool` on
  the parent. Copying Hermes’ MCP-as-client or exploding that loopback into
  Kubernetes does not shrink the 40k file.
- Cycle 41: the loop also **imports a controller**
  (`agentModeService.ts` L29894 → `controllers/blog.ts`). Cycle 42: five
  more service files do the same (`emmaEmailService.ts` L5 is a **static**
  import of `generateSessionResponse`). A-013 parks the family.

## Loop inbound faces (cycle 43)

`agentModeController.ts` (14,929 lines) is already the in-process
composition root — three exports, many adapters, one process:

| Export | Line |
|---|---|
| `runVerifiedChat` | L5019 |
| `runScheduledChat` | L5362 |
| `generateSessionResponse` | L7908 |

Upstream: email, Slack, GTM, admin, imageReports, human eval, revision.
**#2393** (ENG-272) extracts `services/conversation/channelPort.ts` + Slack
adapter — the OMP/Hermes move, already in flight. Do not compete. Do not
HTTP-split Emma. `executeAgentStep` still throws (A-003).

## Cycle 228

AgentWeb MCP (`createMcpServer` in `mcpServerCore.ts`) is already the
**external** composition bus for Hermes. SoL-Pi / OMP packages are
**host ports** (`perm-20260911-hermes-pi-plugin-adapter-is-host-port-not-abi`).
Do not add a Tasks extension or a fifth `listen()` because Linear
PER-1257 / PER-1355 exist. Q-017 (park) is initialize `instructions` +
`additionalProperties: false` on advertised roots — handshake
hygiene, not a hop.

## Cycle 229

PER-1522 four buckets: AgentWeb already occupies **operator** (MCP
server for Hermes) plus **creative-loop** (image/video/eval). Do not
add a fifth `listen()` to absorb Pipeline Studio, Artifact Ledger, or
Dash Orchestra. Q-017 stays handshake hygiene.
