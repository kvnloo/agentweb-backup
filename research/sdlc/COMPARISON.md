# Code-quality comparison for agentic development

Snapshot: 2026-09-11T18:45Z, OMP DAG refreshed **19:17Z** (cycle 30). Hermes
and OMP via public GitHub; AgentWeb from this clone.

## Size (what an agent must hold)

| Surface | Lines or bytes | Notes |
|---|---|---|
| AgentWeb `agentModeService.ts` | **40,571 lines** | June strangler baseline was 24,205. Grew ~16k after “extraction.” |
| AgentWeb `agentModeController.ts` | 14,929 | Locks, scheduled chats |
| AgentWeb `db.ts` | 11,671 | Harsha / data-plane |
| AgentWeb `emma/tools.ts` | 9,780 | In-app registry, one file |
| AgentWeb `agentMode/` (extracted) | 10,167 prod+tests mixed | `core/toolDispatch.ts` 1,409 is the biggest extracted chunk |
| `executeAgentStep` | skeleton **throws** | `core/agentStep.ts` L48–55 |
| Hermes largest Python | ~392 KB `plugins/platforms/telegram/adapter.py` | Still big, but **plugins**, not the loop |
| Hermes `tools/` | many files, self-register | Documented acyclic import: registry ← tools ← model_tools |
| OMP `@earendil-works/pi-ai` etc. | bun **packages/** | `pi-ai`, `pi-agent-core`, `pi-coding-agent` (scope renamed from `@oh-my-pi`, cycle 30) |
| OMP largest TS | `packages/coding-agent/src/session/agent-session.ts` **445 KB** | They also have god files; they **contain** them in a package |
| OMP README claim | ~80k lines Rust core | `crates/pi-builtins`, `pi-shell` |

**Read:** OMP/Hermes are not “small files everywhere.” They are **bounded
packages** so a coding agent can open `packages/agent` without `db.ts`.
AgentWeb’s extracted `agentMode/core` is the right direction and is
incomplete; the monolith is still the default place to add features.

## Topology

```
Hermes:     CLI / gateway / ACP  ──► AIAgent ──► registry ──► tools/*.py
                                     (one process; registry.py has no tool imports)

OMP:        coding-agent CLI    ──► pi-agent-core ──► pi-ai ──► pi-catalog
            (package.json this cycle: ai does **not** depend on agent-core)

AgentWeb:   customer-portal (other repo)
            partner-portal EB  ─┐
            backend EB        ─┼─► parent I/O (HTTP, Socket.IO, cron, MCP server)
            agent-engine VM    ─┤   + fork worker compute (same 40k class)
            remotion-lambda    ─┘   MCP loopback: localhost → emmaApi → generateImage
            loops/index.ts      ──► ./core/types only (cycle 35; Hermes registry)
            app.ts L118–120     ──► instances register (explicit, not discover)
            mcp/server/registry ──► already imports evaluationPolicy (not loops-clean)
            mcp/client ↛ mcp/server (cycle 56; OMP DAG already true)
            chatbot on parent   ──► still executeTool (cycle 46; hexagon leaks)
            app.ts → crm.ts L24 ──► server.ts (cycle 59; IoPort too small)
```

## OMP workspace DAG (live 2026-09-11T21:48Z `earendil-works/pi` **0.85.1**)

Cycle 20 used `@oh-my-pi/*`. npm scope is now `@earendil-works/*`. Arrow
unchanged: `pi-ai` does **not** depend on `pi-agent-core`.

| Package | Depends on `@earendil-works/*` (0.85.1) | Must not depend on |
|---|---|---|
| `pi-ai` | pi-telemetry; **no** agent-core | **agent-core** |
| `pi-agent-core` | **pi-ai**, chord, pi-telemetry | coding-agent |
| `pi-coding-agent` | agent-core, pi-ai, tui, chord | — |

Live `earendil-works/pi` `@earendil-works/pi-ai` **0.85.1** (cycle 88
reconfirm; released 2026-09-05). Arrow unchanged: `pi-ai` does **not**
depend on `pi-agent-core`. `sideEffects` include `./dist/images.js` and
`./providers/images/register-builtins.js` — images are an in-process
submodule of the leaf package (A-008, not A-006). Cycle 88: 0.85.1
**unpublished** experimental `./client` / `./experimental/plugin`
(`source`-only exports; `pi-server` / `pi-client` are
devDependencies). They tried shipping a server split in 0.85.0 and
reverted. Do not copy that as A-006.

## Agentic SDLC practices

| Practice | Hermes / OMP | AgentWeb |
|---|---|---|
| Documented target loop | Yes | `AGENTMODE_MIGRATION.md` — **stale scorecard** (24k vs 40k) |
| Characterization tests | pytest volume | `backend/src/__tests__/agentMode/characterization/` exists |
| Eval / bench on tools | OMP “benchmaxxed” edits; metaharness package | `loops/` framework; human eval for images (not a router) |
| Module boundary in CI | package graph / AST `discover_builtin_tools` | **No** (A-002 sketch only) |
| Skills as files | `skills/` + optional-skills | Skills in system prompt + DB `foundation_tools` |
| MCP | Client (`mcp_tool.py` skipped by discover; `supports_parallel_tool_calls` default **false**, cycle 89) | Server for Hermes **and** client to vendors; self `"agentweb-tools"` skipped **on file config only** (`mcpClientService.ts` L420–432); DB `mcp_servers` does not (cycle 90) |

## Implications (not a port)

- Do not copy Hermes’ Telegram adapter size into Emma.
- Do not copy OMP’s Rust natives.
- Do copy: **package boundaries, registry import DAG, section-file MCP
  (ENG-982) then one-tool-per-file later, keep the loop in-process, MCP
  as the *external* nanoservice bus.** Do not copy Hermes’ 1-file-per-tool
  **or** `discover_builtin_tools` as the *first* A-007 PR
  (`A-007-split-map.md`). `loops/adapters/awsAdapters.ts` is the host
  package; do not import it from `core/`.
- `loops/core/ports.ts` is closer to OMP `pi-agent-core` than
  `agentModeService.ts` is. `LoopPorts` (L143–150) is six injected
  interfaces wired at `productionLoopPorts()` — that is how nanoservices
  already compose here. Promote that pattern; don’t invent K8s.
- Cycle 39: Hermes would expose **one** `generate_image` schema.
  AgentWeb already has two (Emma camelCase + HITL vs MCP snake_case
  HTTP adapter). That is composition drift, not a reason to add a
  fifth process. Q-014 lists the adapter; A-011 parks unifying it.
- Cycle 46: Hermes keeps sockets and the loop in one process. AgentWeb
  already split parent **I/O** from worker **compute**, then left Emma
  chatbot `executeTool` on the parent. Do not HTTP-split `generateImage`
  (three faces: parent MCP, parent chatbot, worker chat).
- Cycle 47: Hermes one `tools/list`. AgentWeb three catalogs for
  `generate_image` (MCP `internal`, chatbot `images` page, Agent Mode
  skills — not foundation). Q-014 lists MCP; A-014 parks copying the
  other catalogs.
- Cycle 48–49: AgentWeb `ListTools` has no skill gate. Lazy auth
  (ENG-984) may list to strangers; `ANONYMOUS_TOOLS` is empty so they
  cannot run. Hermes OAuth (Q-001) is still the execute path.
- Cycle 54: ENG-982 `workflowTools.ts` is mixed-identity (`adminClientScope`
  for `emma_get_account_status`). A-007 copies mcpFetch shape, not that
  import. OMP 0.85.1 still registers images inside `pi-ai`.
- Cycle 55: remotion-lambda is Chromium/ffmpeg isolation;
  `recordVendorUsage` stays in `remotionService`. `imageGeneration.ts`
  is already the host adapter (vendor HTTP). Do not copy the Lambda
  process onto images.
- Cycle 56: `mcp/client` ↛ `mcp/server` (prod). Shared
  `anonymousToolAccess.ts`. Do not HTTP-split; park A-016 until A-002.
- Cycle 57: `app.ts` is the composition root. #2271 owns its route table.
  A-007 attaches at `mcpServerCore`, not `app.ts`.
- Cycle 58: `server.ts` drain (ENG-1189 L404–413) waits on in-flight
  mcpFetch before `server.close()`. Hermes: one process, no second listen().
- Cycle 59: `crm.ts` L24 / worker L184 / `crmEnrichmentService` L67
  import `server.ts` despite `registerIo`. Hermes packages do not import
  the CLI for sockets. Park A-017 (expand `MinimalIo`, not HTTP).
- Cycle 60: A-017 is `getFathomLinearPort` (`fathomWebhook.ts` L39),
  not `LoopPorts`. `chatSocketHandler` already extracted from `server.ts`
  (ENG-1222 L17–20). Do not put live rooms on the loop package.
- Cycle 61: AgentWebPro still empty on `apiTools.ts` / `loops/core` /
  `sessionSockets.ts`. `app.ts` is now #2271 **and** #1814.
- Cycle 62: one `socket.join` (`server.ts` L186 `user:`). CRM uses
  `socket.id`; codingAgent emits `sessionId` with no join. A-017 is a
  passthrough, not a room enum.
- Cycle 63: `gtmPlan.ts` L12–13 / L1495 documents dynamic
  `import('../server')`. Ten such sites plus cycle-59 requires.
  Partner-portal GTMPlans listens with no client join.
- Cycle 64: worker IPC already splits SSE (`type:'progress'`) from
  Socket.IO (`type:'socketEmit'`). `RunEmitter` typed sink is a no-op.
- Cycle 65: `sseProgress` Maps are parent-heap only (same as
  `instanceState` — no Redis). Chatbot is per-socket `'message'`.
- Cycle 66: `keyedMutex.ts` L12–15 + `activeSessionGenerations` Set.
  A fifth process would race the claim. Do not Redis-ify the lock.
- Cycle 67: ENG-114 — no sticky routing. Scale-out is Dynamo metadata
  + in-process rehydrate, not HTTP-per-tool.
- Cycle 68: ASG does not wait on SIGTERM drain (`asgLifecycleGuard.ts`
  L4–16, session `d7e4863c`). Hook + `drainForShutdown` are this
  `listen()`. Hermes/OMP: one process, no ASG hook.
- Cycle 69: `runDrain` awaits worker / cron / sessions / live voice
  (`server.ts` L397–420). Inbound MCP `CallTool` (Q-014) is not
  tracked. Chatbot was wrapped (`chatbotTurn`, L288–301); MCP was
  not. Hermes keeps the tool in-process so there is no second hop
  to drain.
- Cycle 70: two inbound MCP faces (local Map vs ENG-114 rehydrate)
  share `CallTool`. Wrap that once. Node `server.close()` is not
  the waiter for inner mcpFetch.
- Cycle 71: AgentWebPro empty on `mcpServerCore.ts` /
  `cronJobRegistry.ts` / `mcpServer.ts` / `asgLifecycleGuard.ts`.
  Wrap is mergeable after #2, not instead of Q-014.
- Cycle 72: local GET `/mcp` SSE (`mcpServer.ts` L508–531) hangs
  `server.close()`. Ordered drain: wait CallTool, then
  `mcpShutdown`, then close. Hermes has no inbound SSE.
- Cycle 73: `server.close((err) => …)` is not a Promise. The ASG
  hook awaits drain then `CompleteLifecycleAction`. Source-pinned
  ENG-1189 tests order, not join. Hermes exit *is* close.
- Cycle 74: `workerShutdownGuards.ts` ignores SIGTERM so the parent
  can drain then SIGKILL. A fifth `listen()` gets the cgroup
  SIGTERM with Node’s default handler (ENG-201). Hermes: one
  process, no sibling to ignore.
- Cycle 75: `RecordLifecycleActionHeartbeat` is never invoked.
  Three 900s knobs (ASG hook, EB rolling Timeout, comment in
  `runDrain`) are dead-man's switches stacked above a 10 min
  ceiling. A fifth `listen()` is in none of them.
- Cycle 76: inbound MCP is on the global nginx/ALB 600s path.
  Socket.IO is the 3600s exception. Hermes SSE idle > 10 min
  dies at the proxy even if Node never times out.
- Cycle 77: mcpFetch default abort is 5 min; `generate_image` does
  not override. v0 tools pass 25 min on the same hop instead of
  extracting a process. Hermes: one execute() timeout.
- Cycle 78: leaf `IMAGE_GENERATION_TIMEOUT_MS` is 8 min (ENG-510,
  below the 10 min turn). MCP abort is 5. Two clocks on one leaf.
  Align `timeoutMs`; do not add a process.
- Cycle 79: aborting mcpFetch does not stop `generateImage` or skip
  the leaf meter. Hermes execute() abort is the same promise.
  Do not add a hop whose cancel story does not exist.
- Cycle 80: `tryClaimSessionGeneration` is Agent Mode only.
  MCP generate_image is unclaimed. Hermes loop is the concurrency
  bound. Do not copy the Set onto emmaApi; do not HTTP-split.
- Cycle 81: MCP quota is check-then-act (`checkTokenUsage` GET,
  then `next()`). Increment is post-success, fire-and-forget,
  month-conditioned ADD — not a remaining-quota reject.
  Hermes bounds parallel tools in the loop; AgentWeb MCP is a
  server that admits N Express POSTs. Do not HTTP-split to
  “atomize” a GET. Do not wire ENG-1250 admission (Harsha).
- Cycle 82: image meter is `$` / 0 tokens. Default hard gate is
  tokens. Hermes loop still bounds spend; AgentWeb’s token cap
  does not, unless cost enforcement is on. Do not flip
  `ENFORCE_COST_CAP` from a research timer.
- Cycle 83: MCP Streamable HTTP SDK fans out CallTool (new
  `streamId` per POST). Hermes loop is the bound; AgentWeb server
  is not. Do not HTTP-split to get a mutex the SDK does not have.
- Cycle 84: `checkExtraCostUsage` is tests-only. Images do not
  write `extraCostUsage` (CRM enrichment does). Three counters;
  MCP images move only observe-only `$`. Do not HTTP-split to
  inherit a dead gate.
- Cycle 85: default image is $0.134 in `llmPricing.ts`; Hermes
  omitting `image_model` hits that. OMP keeps prices in `pi-ai`.
  Do not HTTP-split the book. Q-003 is the cheaper-model mapper.
- Cycle 86: video is the same meter, Emma-catalog only. MCP grep
  empty. Do not HTTP-split video to “prepare” Q-016.
- Cycle 87: 20 AgentWebPro PRs still miss `apiTools.ts` /
  `llmPricing.ts` / `loops/core`. Hermes does not wait on a
  god-object pile to list a tool. Do not HTTP-split for collision.
- Cycle 88: OMP 0.85.1 unpublished experimental client/server.
  Cutting-edge this month is in-process SDK + stdio, not a fifth
  `listen()`.
- Cycle 89: Hermes `mcp_tool.py` is still a client loader.
  `mcp_tool_server_run.py` is remote-session lifecycle. Parallel
  MCP is `supports_parallel_tool_calls` default false. Do not
  HTTP-split to get a mutex Hermes already owns on the client.
- Cycle 90: AgentWeb’s self-MCP skip is file-config only. Dynamo
  `mcp_servers` + admin localhost URL still connect. Copy the
  filter (A-018 park); do not HTTP-split to “close the loop”.
- Cycle 91: live face is `/mcp` (`mcpServer.ts` + OAuth metadata).
  `/mcp/server` is inspector + AGENT_API L129 drift. Q-001 runbook
  already matches. Do not HTTP-split a renamed URL.
- Cycle 92: `mcp:inspector` is `--transport sse` against `/mcp/server`.
  Live initialize is POST `/mcp`. GET `/mcp` without session is 400.
  Do not HTTP-split to fix a script.
- Cycle 93: two SIGTERM listeners. `mcpShutdown` closes inbound
  CallTool first; `runDrain` waits second. ASG still drains before
  SIGTERM. Do not HTTP-split to get one handler. OMP still 0.85.1.
- Cycle 94: shutdown does not `sessionStore.delete`. Hermes session
  ids rehydrate on the next instance (ENG-114). A fifth `listen()`
  is another local Map plus the same Dynamo mirror.
- Cycle 95: this tree never sets `MCP_SESSION_STORE`. Default memory.
  Dynamo rehydrate is opt-in. Do not HTTP-split to survive deploys;
  Hermes already re-inits on 404.
- Cycle 96: Immutable + weekly refresh already overlap two instances.
  `socialPosts.ts` MinSize=MaxSize=1 is not in `.ebextensions`.
  A fifth `listen()` is a third process in that window.
- Cycle 97: drain 503s `/run-scheduled-chats` only. `/health` stays
  200. MCP has no `isCronEnabled`. Hermes has no 503 hop; Q-001
  404-reinits. Do not HTTP-split to get a drain admission.
- Cycle 98: `cronJobRegistry.drain()` is live (`inFlight.size`).
  `track()` has no `draining` flag; the worker does. Wrap CallTool
  after #2 must copy that pair, not `track()` alone.
- Cycle 99: `chatbotTurn` already `track()`s Socket.IO with no
  admission. `io.close` is after the wait. The wrap footgun is
  in-app Emma today, not only a future MCP wrap.
- Cycle 100: Slack/email ack 200 then `track()`. HTTP is already
  gone; `server.close` does not abort. Park A-019: flag on
  `track()`, not `slack.ts` (#2393). Hermes: one process.
- Cycle 101: `/generate` never `track()`s. Second live waiter is
  `activeSessionGenerations`. A-019 first slice: `instanceState`
  bit consulted by `track()` and `tryClaim`. Not a `/generate`
  nanoservice.
- Cycle 102: media/work-plan auto-continuation `setImmediate`s
  after lock release and `tryClaim`s again. Live drain sees
  1→0→1. Not an image nanoservice.
- Cycle 103: `emma_get_session` is listed, not internal, and
  GETs a handler the comment calls a “passive READ” that starts
  billed generation. Hermes poll during overlap. Not A-006.
- Cycle 104: `emma_send_message` default mcpFetch 5 min;
  `/generate` cancel-on-close; drain waiter 10 min. Image leaf
  ignores abort. Not a send_message nanoservice.
- Cycle 105: POST self-call is not retried (`httpClient.ts`
  L116–118). GET `emma_get_session` retries 3× after close and
  still fails. Hermes on the new instance never sees the old
  `isError`. Not A-006.
- Cycle 106: inbound `/mcp` and loopback mcpFetch are different
  sockets. `closeIdleConnections` is typed and unused. Hermes
  fails at nginx; the wrap is only if CallTool already
  `execute()`d. Not a fifth `listen()`.
- Cycle 107: close() is nginx 502 immediately; 600s is 504 on
  an already-connected SSE. Classifier: 502 `upstream_5xx`, 504
  `timeout`, loopback `network`. Not A-006.
- Cycle 108: ALB health cannot stop Hermes during drain. Zero
  `HealthCheckPath`. Always-200 `/health` is ENG-1189’s
  load-balancer face. Not a health nanoservice.
- Cycle 109: enhanced-health probe is deploy-verify (ENG-878).
  Zero process callers. `LAGGING` is post-terminate. Not a fifth
  `listen()`.
- Cycle 110: weekly `InstanceRefreshEnabled` overlaps without
  `eb-deploy.sh`. Same ASG hook, no ENG-878 probe. Not A-006.
- Cycle 111: Sunday + Immutable do not stack. Must be Ready;
  wait 1200s or fail. Hermes/OMP: one process. Not A-006.
- Cycle 112: 3×1200s settle is not a wait. `fail()` exits
  attempt 1; 2700s total caps retries. Not a 3600s third clock.
- Cycle 113: last deploy’s hook dies with the Immutable ASG.
  Sunday recycle is not that hook. Park A-020. Not A-006.
- Cycle 114: guard still drains without a hook; ASG does not
  wait. Two IMDS `Terminated` reads. Not a fifth `listen()`.
- Cycle 115: Sunday SIGTERM is OS/cgroup (ENG-201). This tree
  does not keep it alive. 900s is not Sunday. Not A-006.
- Cycle 116: journald drop-in is not the Node unit. Sunday
  `TimeoutStopSec` is live-AWS-only. Not A-006.
- Cycle 117: `runDrain` never stops nginx. Stop order is
  live-AWS-only. Not a fifth `listen()`.
- Cycle 118: `PORT=8080` is not in git. `.env.example` is 3001.
  Only git `proxy_pass` is `/socket.io/`. Not A-006.
- Cycle 119: cannot name platform nginx.conf (`app.ts` L152–155).
  Docs default upstream 5000. Hermes/OMP: no proxy file. Not A-006.
- Cycle 120: git never chooses 3001/8080/5000. Zero
  `application:environment` in `.ebextensions`. Not A-006.
- Cycle 121: a `/mcp` location is instance-only. ENG-836 allows
  it alone, forbids it with ALB `.ebextensions`. Not A-006.
- Cycle 122: detect-changes skips drafts (`tests.yml` L18).
  ENG-836 never sees a draft `/mcp` PR. Pass ≠ deployable.
- Cycle 123: re-draft is `NO_EVIDENCE` (`merge-evidence.sh` L264).
  `gh pr checks` can still look green. Not A-006.
- Cycle 124: ENG-836 skip is not draft. Discriminator has no path
  filter. Conflict job is not `BACKEND_JOBS`. Not A-006.
- Cycle 125: 5-minute comment is #2491; live ceiling is 12. Hung
  ENG-836 still PASSes merge-evidence. Not A-006.
- Cycle 126: in-flight ENG-836 is PENDING; cancel-in-progress turns
  it into cancelled PASS. Separate concurrency groups. Not A-006.
- Cycle 127: ENG-1373 is still an unlanded comment. Nothing in
  git adds Backend build to GitHub required contexts. Not A-006.
- Cycle 128: merge-evidence labels Dependabot skip as a
  path-filter skip; #2491 PASSes with it skipped. Not A-006.
- Cycle 129: GitHub treats a job-level `if` skip as Success;
  Dependabot REQUIRED only bites when the job runs. Not A-006.
- Cycle 130: naming Backend build as required cannot reproduce
  merge-evidence section 7. Not A-006.
