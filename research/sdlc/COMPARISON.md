# Code-quality comparison for agentic development

Snapshot: 2026-09-11T18:45Z, OMP DAG refreshed **19:17Z** (cycle 30);
Hermes/OMP versions reconfirmed **2026-09-12T00:38Z** (cycle 159:
OMP still v0.85.1; Hermes `v2026.9.11` + main MCP client ~24 files).
Schema pin **2026-09-12T00:45Z** (cycles 162–165: live
`image_generation_tool.py` 833 lines; `IMAGE_GENERATE_SCHEMA` L522).

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
| MCP | Loop is **client** (`mcp_tool.py` skipped by discover; parallel default **false**, cycle 89). Two opt-in **stdio** servers: `hermes mcp serve` (conversations) and `hermes-tools` for Codex including `image_generate` (cycle 160). `image_generate` schema is capability-gated (`dynamic_schema_overrides`, cycle 163) and fail-closed at the leaf (cycle 164). Dashboard `/api/mcp/oauth/callback` is outbound config, not `tools/list`. | Server for Hermes **and** client to vendors; self `"agentweb-tools"` skipped **on file config only** (`mcpClientService.ts` L420–432); DB `mcp_servers` does not (cycle 90). Listed `generate_image` is a static superset (cycle 162–165) |

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
- Cycle 131: merge-evidence has no PARTNER_JOBS; partner-only
  PASSes with Partner skipped. Not A-006.
- Cycle 132: no WORKFLOW_JOBS; editing merge-evidence.sh PASSes
  with CI script tests skipped. Not A-006.
- Cycle 133: ENG-1377 relay and remotion builds are unnamed in
  merge-evidence. Not A-006.
- Cycle 134: a tests.yml PR schedules six jobs; merge-evidence
  requires Backend build only. Not A-006.
- Cycle 135: agent-engine is a deploy unit with no GitHub build
  job. Not A-006.
- Cycle 136: customer-portal is a fifth repo (gitignored), not
  a fifth process. Not A-006.
- Cycle 137: other repo IA is a typed list in this backend
  (customerPortalPages.ts), one GET. Not A-006.
- Cycle 138: growth-chat is a sixth origin; callLLM stays in
  this process. Not A-006.
- Cycle 139: Growth Genius is a fifth in-process catalog
  (inline search_knowledge_base + Emma KB). Not A-006.
- Cycle 140: KB search is a leaf trapped in a file that
  cycles with agentModeService. Not A-006.
- Cycle 141: ENG-1057 already named three in-process KB faces;
  cap at the source. Not A-006.
- Cycle 142: those faces do not share source sets. Agent Mode
  is a Drive/ClickUp superset; Emma RAG and Growth Genius are
  Vertex-only. Hermes/OMP: one name, one source set. Not A-006.
- Cycle 143: listed MCP search_knowledge_base already hops to
  that Agent Mode superset; generate_image is still internal.
  Q-014 is listing, not a new hop. Not A-006.
- Cycle 144: Agent Mode still recaps Vertex after ENG-1057
  capped the leaf; L24062 comment is stale. Face test mocks
  the leaf. Not A-006.
- Cycle 145: three TypeScript searchKnowledgeBase symbols.
  Emma export is Azure embeddings over in-memory docs;
  Agent Mode is the Drive/ClickUp superset; Growth Genius
  is Vertex-only. Hermes: one name, one handler. Not A-006.
- Cycle 146: three JSON schemas for search_knowledge_base.
  GG requires reason; Emma/MCP require query only. A-011
  already parks this pattern for generate_image. Not A-006.
- Cycle 147: GG reason is required then discarded before the
  Vertex leaf (L174 vs L177). Unifying it away is a no-op
  on retrieval, unlike confirm on generate_image. Not A-006.
- Cycle 148: GG and Emma RAG hardcode maxResults=10; Emma
  tool / MCP default 5 then AM min(,10). Cardinality is
  per-face, not a leaf port. Not A-006.
- Cycle 149: Agent Mode collects per source then slices
  (L24233). Vertex-first prefix can discard Drive/ClickUp
  after OAuth and reads. Listed MCP hops here. Not A-006.
- Cycle 150: no short-circuit after Vertex (L24070 → L24073
  if userId Drive). Only empty-set gate is L24216. Not A-006.
- Cycle 151: ClickUp docs search is list-all then includes()
  (clickupService.ts L103-119; AM L24150-24158). Drive is
  fullText contains (L24092). Not A-006.
- Cycle 152: listTasks enriches attachments (L219-258);
  search only uses name+description (L24194-24196). List
  tool uses attachmentCount (L24887). Not A-006.
- Cycle 153: readDocContent lists pages then may GET each
  (L137-165) before includes(); nameMatch L24155 does not
  skip the fetch. Drive reads hits only. Not A-006.
- Cycle 154: Drive has ENG-1624 count+time bounds (L23581
  perBatchTarget L23879); clickupService.ts grep TIMEOUT /
  MAX_MS / deadline is empty. Copy the bound shape. Not A-006.
- Cycle 155: Drive folder trees Promise.all (L24080);
  ClickUp docs sequential await (L24148-24156). Drive
  post-query file reads also sequential (L24105). Not A-006.
- Cycle 156: search readGoogleDriveFileContent (L25194)
  and readDocContent (L134) have no download cap.
  Materialize 200MB (L25626); named-read 1M after fetch.
  Search keeps 5000 chars. Not A-006.
- Cycle 157: search query fields omit size (L24093);
  listing L24690, named-read L25482, materialize L25678
  request it. Helper interpolates (L23941). Not A-006.
- Cycle 158: Workspace files.export (L25198) empty size;
  named-read L25606 falls back after download. Metadata
  refuse misses Docs/Sheets/Slides. Not A-006.
- Cycle 159: live Hermes MCP client ~24 tools/mcp_* files;
  registry skip mcp_tool.py now L97. OMP still v0.85.1
  (2026-09-05). In-process split, not a mesh. Not A-006.
- Cycle 160: mcp_tool_server_run.py still connect-only;
  “/mcp refresh” is a slash-command. hermes mcp serve and
  hermes-tools are stdio subprocesses. Not inbound HTTP.
- Cycle 161: hermes-tools image_generate dispatches
  handle_function_call in-process (L90). Q-014 lists;
  AgentWeb mcpFetch is the adapter. Not A-006.
- Cycle 162: Hermes image_generate schema is prompt +
  aspect_ratio (IMAGE_GENERATE_SCHEMA L522–554). MCP
  generate_image requires prompt+filename+category (L2093).
  A-011 already parks Emma vs MCP. Do not add A-021.
  Not A-006.
- Cycle 163: Hermes dynamic_schema_overrides hides
  image_url on t2i-only models (L781–815; test_t2i_only_
  model_hides_edit_args). AgentWeb MCP always lists
  input_images. Agentic-dev quality is an in-process
  builder, not a fifth listen(). Not A-006.
- Cycle 164: Hermes also refuses at _prepare_fal_request
  L367–370. AgentWeb validateParams is quality+filename
  only (L1514–1533); generateWithGoogleGemini still edits
  on the model Emma calls t2i-only (L924). Not A-006.
- Cycle 165: logo_image is inputImages.push before the
  model switch (L477–485). Emma “no logo compositing”
  is catalog text; the leaf mutates. Hermes has no logo
  field and fail-closes. Not A-006.
- Cycle 166: Four catalogs (MCP free string, Emma enum,
  SUPPORTED_MODELS, IMAGE_API_MODELS). L2203 “must match”
  is false. Hermes FAL_MODELS is one catalog the tests
  pin. Not A-006.
- Cycle 167: HITL L28893 before leaf Invalid imageModel
  L502. MCP free-string + input_images wastes a confirm.
  Hermes model is out-of-band hermes tools. Not A-006.
- Cycle 168: Runway L1363 referenceImages from the mutated
  array; still textToImage.create. Admin no-Runway is
  not a capability gate. Not A-006.
- Cycle 169: Azure /images/edits L651 inputImages[0] only.
  Logo push last → edit+logo drops logo bytes, keeps
  CRITICAL LOGO prompt. Hermes raises rather than drop.
  Not A-006.
- Cycle 170: L492 Gemini 3 default “supports multiple input
  images.” Q-003 cheaper gpt-image-2 default would land
  unspecified on that drop. Mapper stays ready; flip stays
  Matt-gated. Not A-006.
- Cycle 171: Azure L654 axios.get skips processInputImage
  (30s / UA / SVG). Gemini/Runway use the helper. Not A-006.
- Cycle 172: Azure FormData contentType image/png always
  (L662). Gemini/Runway pass sniffed MIME. Not A-006.
- Cycle 173: S3 upload L582–587 always image/png. Gemini 3
  L1319–1320 vendor MIME discarded at persist. C2PA
  sharp().png() makes the default path honest. Result
  type has no mimeType. Not A-006.
- Cycle 174: Runway L1400 HTTPS skips L570–572 C2PA+S3;
  meter already ran. 2 of 8 models. Strip is a second
  Emma/REST tool, not MCP. Not A-006.
- Cycle 175: generateWithOpenAI else L533–534 unreachable
  after includes(SUPPORTED_MODELS). DALL-E URL persist is
  dead; Runway is the live URL skip. Not A-006.
- Cycle 176: meter provider L554–558 is prefix not
  dispatch. gemini_2.5_flash meters runway by underscore;
  gpt-image is Azure labelled openai. Video uses
  isHiggsfieldModel. Not A-006.
- Cycle 177: BLOG_SETUP.md L9 / L46–67 / L34 is a stale
  fifth catalog (GPT Image 1 + DALL-E 3 + Picsum +
  OpenAI/Image). generateBlogImage omits imageModel
  (blog.ts L648) so L492 Gemini 3 / Google/Image fires.
  Agent-engine web_agent.py L3299 still has a live
  OPENAI_IMAGE_API_KEY. Not A-006.
- Cycle 178: two deploy units, two image dispatch tables.
  Intersection gpt-image-1 + gemini-2.5-flash-image.
  Unspecified Emma → Gemini 3; unspecified browser task →
  openai-image-1 → OpenAI else (web_agent.py L3295-3301).
  gpt-image-2 is Azure on the leaf. Q-003 already parks
  image-models.ts L11. Not A-006.
- Cycle 179: ImageModelsSettings.tsx L71-89 seeds
  openai-image-1 + FLUX + gemini-2.5, not gpt-image-1.
  Empty Dynamo auto-inits that list (L129-131). CLI help
  L4216 same omission. Worker L3281 is unadvertised.
  Not A-006.
- Cycle 180: onboardingAdImageService.ts L84/L493 always
  passes gemini-3-pro-image-preview so leaf L492 never
  fires. Q-003 item 4 skips explicit model and logoImage.
  1080x1350 is Gemini 4:5 (L1157), not Azure size
  (L712 raw). Not A-006.
- Cycle 181: generateWithTimeout L487-507 is a 180s
  Promise.race with no AbortSignal. Leaf withTimeout L89
  is 8 min. Meter L551 after inner success; UI already
  placeholder. Test L375 blesses elapsed not cancel.
  Not A-006.
- Cycle 182: Gemini 3 data URL takes L566-587 S3 upload
  (not cycle 174 HTTPS skip). Key users/{userId}/files
  (s3Utils L264). Zero DeleteObject. ENG-792 only fails
  liveCount===0. Not A-006.
- Cycle 183: uploaded-by is a hardcoded agent-mode
  constant (s3Utils L276 and L352). Signature has no
  caller tag. workPlanThumbnailService.ts L37 stamps
  workplan-thumbnails on its own S3 client. Hermes
  persist stays with the producer. Not A-006.
- Cycle 184: uploaded-by is write-only. HEAD callers
  (agentModeService L28645, filesController L39/L307)
  read ContentType/ContentLength. assetController L3
  imports getS3ObjectMetadata unused; L117 HEADs for
  MIME. Helpers have zero Tagging. Hermes MEDIA tags
  are read. Not A-006.
- Cycle 185: helpers omit CacheControl (s3Utils L269-279
  / L345-355). filesController L379 is the README HTML
  form save. README L1537 max-age=60 is CLI copy-object
  (L1553). Thumbnail L35 is the only PutObject
  CacheControl (immutable 1y). CloudFront function is a
  README snippet; glob **/*cloudfront* empty. Not A-006.
- Cycle 186: serveAsset L124 hardcodes max-age=300 after
  HEAD L117. headResult.CacheControl never read. Email
  rewriteS3ImageUrls (emailVariables.ts L187) hops here
  (drip L187, sequences.ts L353). WorkPlans.tsx L824 uses
  raw thumbnail_url. Tests never import serveAsset.
  Not A-006.
- Cycle 187: rewrite S3_BUCKET_HOST L178 is one regional
  hostname. decodeAssetHash accepts region-less +
  execution-gifs (assetController.test.ts L10/L20/L30).
  Brand deriveOwnBucketKey (L84) already matches bucket
  not hostname spelling. Rewrite tests only use L178.
  Not A-006.
- Cycle 188: three S3 URL writers. Helpers return
  result.Location (s3Utils L285; tests mock
  https://s3.amazonaws.com/bucket/key). Brand L60-64
  / db L3006 / tasks L1153 construct
  ${bucket}.s3.${region}.amazonaws.com/${key}. Remotion
  L204 is path-style s3.${region}/bucket. Zero
  s3ForcePathStyle. Hermes one persist, one URL shape.
  Not A-006.
- Cycle 189: Family B is not one function. books.ts
  L43-47 encodeURIComponent per segment (again L1810).
  Brand L47-62 interpolates originalname raw.
  extractS3KeyFromUrl L27 does not decode;
  deriveOwnBucketKey L97 does. Hermes one encoding.
  Not A-006.
- Cycle 190: CORS Origin is origin=== Family B host
  (app.ts L224 / L256) with credentials: true (L293).
  cors.test.ts never pins s3. CloudFront forms already
  match *.agentwebforms.com (L220). Repair
  includes('agentweb-user-files.s3') is wider.
  Not A-006.
- Cycle 191: HTML repair is a third matcher, five
  sites (agentModeService.ts L30399–30428).
  Hardcoded prod bucket substring. Same class
  already extractS3KeyFromUrl + getS3ObjectStream
  (L28635). Same method writes Family B with env
  bucket (L30469 / L30619). Tests set test-bucket
  and never pin totalImagesChecked. Path-style
  that s3Utils.test.ts L340 pins still misses.
  Hermes one persist, one decoder. Not A-006.
- Cycle 192: repair axios.gets articleUrl (L30316)
  and images (L30547). Same class already Path A SDK
  (L28631) and Path B presign (L9327 / L38291).
  filesController L35: no public access needed.
  db.ts L2994 uploads without ACL. Gemini comment
  L9304: some screenshot URLs are fetchable.
  Path C fails when the object is private. Hermes
  one persist, one fetch. Not A-006.
- Cycle 193: Emma remove_c2pa / remove_image_background
  advertise S3 URL (emma/tools.ts L4936 / L4969).
  C2PA test L143 pins axios.get of
  https://s3.amazonaws.com/bucket/… Write is
  uploadFileToS3. POST /remove-c2pa metered; no
  REST for background. MCP grep empty. Same axios
  shape as processInputImage L816. Hermes one
  fetch. Not A-006.
- Cycle 194: leaf processInputImage L816 is Path C.
  Gemini 2.5 L929/L1024 and Gemini 3 L1240 have no
  data: skip; Runway L1371 does. logoImage L477
  then L492 Gemini 3 default. ENG-792
  classifyBrandLogoUrl L478 is a 15s Path C probe
  because that GET throws. Tests mock axios for
  example.com; grep processInputImage empty.
  Hermes one fetch. Not A-006.
- Cycle 195: video processInputImage L236 is a
  second Path C (30s, no UA, no SVG, MIME header
  or image/png). Only Veo L393/L418. Default
  seedance-2.0 is media_import_url (L827). Fallback
  L1000 re-enters with the same startFrame. Tests
  spy generateWithVeo31; grep processInputImage
  empty. Hermes one fetch. Not A-006.
- Cycle 196: generateKeyframes L875 calls image
  leaf with no imageModel (Gemini 3 default) then
  Veo L1032 Path-C GETs those Family A URLs.
  useKeyframes is Veo multi-clip only; Seedance
  never reads it. Tests grep empty. Hermes pass
  bytes, not persist-then-HTTP. Not A-006.
- Cycle 197: character referenceImageUrl is Path D
  on Seedance default. Emma L5436 requires the
  generate_image S3 URL; L5385 pass as startFrame.
  media_import_url L827 vendor-fetches. Execute
  L5451 hardcodes empty key. Tests pin example.com.
  Hermes one persist, pass bytes. Not A-006.
- Cycle 198: brand-guide matcher L15132
  includes('.s3.') misses Family A path-style
  (s3Utils.test.ts L53). REST brand.ts L60-62 is
  Family B so it hits. deriveOwnBucketKey L109
  already parses path-style. Hermes one decoder.
  Not A-006.
