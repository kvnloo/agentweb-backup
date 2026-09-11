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
