# Thesis: nanoservices for AgentWeb

## One sentence

Do **not** explode Emma into a mesh of HTTP nanoservices. AgentWeb is
already a **multi-runtime system** with a **god-object backend**. The
cutting-edge move for *agentic* development is a **modular monolith**
(Hermes / OMP shape): in-process packages with ports, one tool per file,
   a typed loop, and extract-to-network only where a deploy unit already
exists. AgentWebPro **#2393** is already extracting a Slack channel port
in-process — that is the move; do not add a fifth HTTP service.

Q-013 (rewrite `agentModeService.ts`) stays **discard**. Network-splitting
the chat loop is the same idea with more latency and a billing footgun.

## What “nanoservice” should mean here

| Layer | Meaning | AgentWeb today |
|---|---|---|
| **Logical** | One operation, one contract, one test surface | Partial: `loops/core` ports, `agentMode/core/*` seams, MCP tool handlers |
| **Package** | Import boundary an agent can hold in context | Missing: `backend/package.json` has no `workspaces` and no dependency-cruiser (cycle 38). Folders + A-002 AST guard first; do not extract npm workspaces instead of Q-014 |
| **Process / deploy** | Independently shipped runtime | Already: backend EB **plus a `child_process.fork` worker that still `new AgentModeService()`** (cycle 44–46: parent = I/O — HTTP, Socket.IO, cron, MCP *server*; worker = compute — `generateMarketingResponse`; chatbot still `executeTool` on the parent). partner-portal EB, agent-engine GCP, remotion-lambda. The fork is event-loop isolation, not a package boundary |

2026 writing that uses “nanoservice” (e.g. telemetryagent.dev) is
explicit that this is **first a logical architecture**, compatible with
a modular monolith. Microsoft’s multi-agent reference architecture
recommends the same: start modular-monolith, extract when scale or
ownership forces it.

A 60-tool HTTP mesh would recreate MCP poorly: `apiTools.ts` already
`mcpFetch`s `http://localhost:${PORT}/api/emma/*`. The MCP *client* even
had a self-server `"agentweb-tools"` (`mcp_config.ts` L3–10) and
**skips it on the file-config path** (`mcpClientService.ts` L420–432)
as a circular dependency. Cycle 90: the Dynamo `mcp_servers` loader
does not copy that filter; admin localhost URLs still connect. Park
A-018 (copy the skip, do not HTTP-split). Q-014 lists `generate_image`
for *external* Hermes; it does not re-enable that self-client.
`ListTools` is `getToolDefinitions()` with **no skill
gate** (`mcpServerCore.ts` L76–83, cycle 48). Anonymous discovery
(cycle 49) may **list** that tool when the ENG-984 flag is on;
`ANONYMOUS_TOOLS` is empty so they cannot **run** it. Cycle 50: a leaked
`CallTool` still dies at `mcpFetch` `lookupUser` (`httpClient.ts` L57–66)
before a self-call JWT. Cycle 51: do not treat `requireEmmaTokenBudget`
as a substitute — it allow-lists `anon_*` (ENG-1163). Cycle 53: this
tool cannot skip `lookupUser` via ENG-1596 (`ctx()` has no
`overrideToken`). Cycle 54: A-007 copies ENG-982 mcpFetch shape, not
`workflowTools.ts` L37 `adminClientScope`. OMP 0.85.1 still has images
as `pi-ai` sideEffects (`images.js`). Cycle 55: remotion-lambda is the
isolate; identity stays in `remotionService` — same as `imageGeneration.ts`
already calling vendor HTTP. Cycle 56: `mcp/client` ↛ `mcp/server`
already (OMP DAG); park A-016 until A-002. Cycle 57: `app.ts` is the
composition root (`setupMcpServer` L204, loop `register*` L475–491);
#2271 owns its route table — A-007 still attaches at `mcpServerCore`.
Cycle 58: `server.ts` drain (ENG-1189) is why mcpFetch must share this
`listen()`. Cycle 59: `app.ts` → `crm.ts` L24 → `server.ts` already
cycles; `registerIo` exists but `MinimalIo` cannot emit — park A-017
(expand emit, do not HTTP-split CRM). Cycle 60: copy
`getFathomLinearPort`, not `LoopPorts` (L143–150). Cycle 63: dynamic
`import('../server')` is the rest of the leak (`gtmPlan.ts` L12–13 /
L1495). Cycle 64: SSE (`sseProgress.ts`) is a second in-process bus;
`RunEmitter` typed sink is empty (`agentModeService.ts` L3449). Cycle 65:
those Maps are parent-heap only (`instanceState.ts` L10–11 same
shape; child worker never imports `sseProgress`). Cycle 66:
`keyedMutex.ts` L12–15 — one session, one process;
`tryClaimSessionGeneration` is an in-memory Set. Cycle 67: MCP
ENG-114 is the scale-out template (Dynamo metadata, in-process
rehydrate, no sticky routing) — not a fifth `listen()`. Cycle 68:
ASG kill is faster than drain (`asgLifecycleGuard.ts` L4–16);
hook `agentweb-drain-before-terminate` parks **this** process
(`server.ts` L572–574). `.ebextensions` cannot install it (ENG-818).
Cycle 69: that drain’s wait list is four named units (`server.ts`
L397–420); inbound MCP `CallTool` is not one (`mcpServerCore.ts`
L88–120 has no `cronJobRegistry.track`). `mcpShutdown` is unused
by `runDrain`. Cycle 70: local Map (`mcpServer.ts` L307–315) and
`rehydrateAndServe` (L441) share that CallTool; wrap it once.
Rehydrate is finite HTTP (`mcpSessionRehydration.ts` L15–18);
mcpFetch still needs a new loopback. Cycle 71: AgentWebPro is
empty on that wrap set (`mcpServerCore.ts` / `cronJobRegistry.ts`
/ `mcpServer.ts`). Do not start it instead of Q-014. Cycle 72:
local GET `/mcp` (`mcpServer.ts` L508–531) disables timeouts; that
SSE is why `mcpShutdown` must follow the CallTool wait. Cycle 73:
`server.close()` / `io.close()` (`server.ts` L440–455) are not
awaited; the ASG hook (`asgLifecycleGuard.ts` L262–273) completes
on drain resolve anyway. Cycle 74: the compute fork ignores
SIGTERM (`workerShutdownGuards.ts` L1–18 / ENG-201); a fifth
`listen()` would not. Cycle 75: `RecordLifecycleActionHeartbeat`
is never called (`asgLifecycleGuard.ts` L26 comment only);
`--heartbeat-timeout 900` (`eb-deploy.sh` L608–613) is CONTINUE
fallback. `DRAIN_CEILING_MS` 10 min (`shutdownConstants.ts` L8)
fits inside EB rolling `Timeout: 900` (`.ebextensions/rolling.config`
L5–7). Cycle 76: GET `/mcp` is nginx/ALB **600s**
(`.platform/nginx/conf.d/agent-mode-timeout.conf` L5–7, no
location; `.ebextensions/timeout.config` L5–6), not Socket.IO’s
3600s (`websocket.conf` L5–16). Node `setTimeout(0)` does not
beat the proxy. Cycle 77: Q-014 `generate_image` mcpFetch uses
the **5 min** default abort (`httpClient.ts` L205); it does not
pass `timeoutMs` (`apiTools.ts` L2096–2108). Landing-page tools
already override to 25 min in-process. Cycle 78: the leaf is
**8 min** (`imageGeneration.ts` L69–79 ENG-510), so MCP’s 5 min
is a stricter face, not the vendor cap. Cycle 79: that 5 min
abort does **not** cancel the leaf (`emmaApi.ts` L174–187 has
no close listener; `generateImage` has no AbortSignal); meter
still runs after success (`imageGeneration.ts` L546–562). Cycle 80:
MCP `POST /generate-image` never calls `tryClaimSessionGeneration`
(`emmaApi.ts` L174–182 vs `agentModeController.ts` L951). Quota is
the brake. Cycle 81: that brake is a GET
(`checkTokenUsage` via UserIdIndex GSI) then `next()`; the ADD
is after success and does not condition on remaining allowance.
`reserveSpend` is unused here (ENG-1250 admission is Harsha).
Cycle 82: the leaf writes `$` with zero tokens
(`imageGeneration.ts` L551–563); default `allowed` is
`tokenAllowed` (`tokenUsageService.ts` L342–396). Cycle 83: MCP SDK Streamable
HTTP mints a `streamId` per POST (`webStandardStreamableHttp.ts`
v1.25.2 L678); AgentWeb adds no mutex. Cycle 84:
`checkExtraCostUsage` is tests-only; images do not write
`extraCostUsage`. Cycle 85: default image is $0.134
(`llmPricing.ts` L301); `gpt-image-2` is $0.04. Cycle 86:
video uses the same `$` / 0-token meter and is not on MCP.
Cycle 87: AgentWebPro empty on those files plus `apiTools.ts`.
Cycle 88: OMP 0.85.1 unpublished experimental client/server.
Cycle 89: Hermes MCP parallel is opt-in (default false).
Cycle 90: self-MCP skip is file-config only; DB path can loopback.
Cycle 91: live HTTP face is `/mcp`; `/mcp/server` is stale.
Cycle 92: inspector is SSE against that dead path; GET `/mcp` needs a session.
Cycle 93: SIGTERM closes inbound MCP before `runDrain` waits.
Cycle 94: that close does not evict ENG-114; only `DELETE /mcp` does.
Cycle 95: `MCP_SESSION_STORE` unset in git; default memory.
Cycle 96: Immutable deploys already overlap two backends.
Cycle 97: drain 503s scheduled chats only; `/health` and `/mcp`
stay open until unawaited `server.close`.
Cycle 98: `cronJobRegistry.drain()` is live; `track()` has no
gate. Worker already refuses new `runInWorker`.
Cycle 99: `chatbotTurn` already extends that live drain; wrap
CallTool after #2 must copy the worker pair.
Cycle 100: Slack/email ack HTTP then `track()`. Park A-019 —
one registry gate, not a Slack nanoservice.
Cycle 101: `/generate` uses `tryClaim` / the session Set, not
`track()`. A-019 must close both.
Cycle 102: auto-continuation re-fills that Set after release.
`tryClaim` refuse is required, not optional.
Cycle 103: listed MCP `emma_get_session` mcpFetchs the GET that
starts that continuation. Do not HTTP-split the leaf.
Cycle 104: listed `emma_send_message` is a 5 min mcpFetch around
`/generate` that *does* cancel on abort. Q-014’s image hop does
not. One process, two clocks.
Cycle 105: that POST is not retried after `server.close`. GET
`emma_get_session` retries 3× into a closed listener. Hermes on
the new instance is a different process.
Cycle 106: inbound `/mcp` (nginx) and loopback mcpFetch (`PORT`)
are different sockets. `closeIdleConnections` unused. Do not
HTTP-split to get a second close.
Cycle 107: refused upstream is nginx **502 now**; the 600s is
the SSE **504**. Three classifier classes for one close(). Do not
HTTP-split to unify them.
Cycle 108: ALB health cannot stop Hermes during drain. `/health`
must stay 200 until close (ENG-1189). A-019 is the gate, not a
health threshold.
Cycle 109: `underlying_health_verdict` is a GitHub Actions probe
(ENG-878), not runtime drain. Copying it into the process would
bless the dying instance. Do not HTTP-split to host it.
Cycle 110: Sunday recycle overlaps without that probe. A-019 is
weekly, not only on merge. Do not disable `InstanceRefreshEnabled`.
Cycle 111: Sunday + Immutable serialize or fail the GitHub deploy
(`Must be Ready`). Not a three-process mesh.
Cycle 112: 3×1200s is not a wait. Settle expiry `fail()`s
(`exit 1`); the 2700s total budget caps retries. Not a
3600s third clock.
Cycle 113: last deploy’s hook is on the ASG Immutable then
discards. Sunday recycle is rolling on the surviving group
with no hook. Park A-020 (second put after verify). Not
`.ebextensions` (ENG-818).
Cycle 114: the guard still drains on two IMDS `Terminated`
reads without a hook. ASG does not wait. 3m19s is overlap,
not park. A-019 fires only if drain starts (`disableCron` first).
Cycle 115: Sunday SIGTERM is OS/cgroup (ENG-201). This tree
does not ship a backend `TimeoutStopSec`. The 900s comment is
Immutable command Timeout, not recycle.
The listed face is a
**thinner** schema than Emma’s in-app tool (cycle 39: no `confirm`,
`emmaApi.ts` L181) and a **different catalog** (cycle 47).
Hop diagram: `COMPOSITION.md`.

## What already exists (do not rebuild)

1. **Strangler, chosen 2026-06-14** — `backend/docs/AGENTMODE_MIGRATION.md`.
   Target loop: `model → parse → typed registry → terminate`. Seams 1
   (termination) and 3/dispatch (`core/toolDispatch.ts`) extracted.
   `executeAgentStep` is still a skeleton that throws.
2. **`loops/core`** — no `services/` / `db.ts` imports; AWS/Slack via
   `ports.ts` (`LoopPorts` L143–150: s3, dynamo, bedrock, slack, clock,
   logger — cycle 33). Wired at `productionLoopPorts()` in
   `loops/adapters/awsAdapters.ts` L219–227. `loops/index.ts` is Hermes
   `registry.py`: only import is `./core/types` (cycle 35). Instances
   register from `app.ts` L118–120, not from a registry scan. Core **does**
   import `loops/index` from `orchestrator.ts` / `instanceRunner.ts`.
   CI does **not** enforce the host-forbid rule. Folder map: `MODULE_MAP.md`.
3. **MCP** — the external composition bus (Hermes, Cursor, Claude).
   ENG-982 already extracted `workflowTools.ts` (5 mcpFetch tools).
   `evaluationTools.ts` is a *different* hop: in-process services + dual
   `emmaToolRegistry` register (cycle 32). A-007 copies workflowTools,
   not evaluationTools. `apiTools.ts` still has 85 registers; splitting
   along its section headers does **not** wait on #2832.
4. **Coding agent** — `codingAgentService.ts` is an **in-process**
   sub-loop (2,387 lines, no `spawn`/`fork`), not a deploy unit. It
   imports `agentModeService` for one settings read (A-010 park). OMP
   `pi-coding-agent` is a package; do not copy that into a fifth process.

## Cutting-edge vs this tree

| Strategy | Hermes | Oh My Pi | AgentWeb |
|---|---|---|---|
| One process for the agent loop | Yes | Yes (`pi-agent-core` package) | Yes, but 40.5k-line file |
| Package / folder graph | `agent/`, `tools/`, `gateway/`, plugins | bun workspaces: `pi-agent-core`, `pi-ai`, `pi-catalog`, … | Three *repos-in-folder* (backend / partner / engine) + one backend blob. Cycle 41: loop imports `controllers/blog` (L29894) — DAG inverted vs Hermes/OMP |
| One file per tool | `tools/*.py` self-register | 31 tools, split packages | `emma/tools.ts` 9.8k lines; `apiTools.ts` 3.6k |
| Typed tool registry | `tools/registry.py` | package `agent` | **Four** in-process tables (cycle 37): `mcpToolRegistry`, `emmaToolRegistry` (3-line `emma/registry.ts`), vendor MCP client, per-session `this.toolRegistry`. Monolith copies Emma tools at L1891 |
| Characterization / eval | ~25k pytest files claimed | edit benchmarks, metaharness | Characterization harness exists; god file still grows (24k → **40.5k** since Jun) |
| Boundary linter | import chain documented | workspace packages | **None**. Cycle 42: at least six `services/` files import `controllers/` (A-013). Cycle 59: CRM/worker import the listen module (`server.ts`); park A-017 |
| Network extract | MCP *clients* to other servers | browser-relay, collab-web as packages | MCP *server*; don’t invert it |

## SDLC to get there (when coding is unlocked)

Order is process, not a rewrite:

1. **Ratchet, don’t rewrite.** New code in `agentMode/core/` or sibling
   modules; net-negative-or-flat `agentModeService.ts` on loop PRs
   (already the migration rule). Monolith grew +16k lines since the
   June baseline — the ratchet is not running.
2. **Enforce the one good boundary.** CI check: `loops/core` must not
   import host services (A-002). Then the same rule for `agentMode/core`.
3. **One-tool-per-file on MCP first (A-007).** Split `apiTools.ts` into
   **section files** like `workflowTools.ts`, not 85 files in one PR.
   First file is `tools/infrastructure.ts` (`generate_image` is **not** in
   the Content section). Keep the barrel. Never `emma/tools.ts`
   while #2832 is open (A-004). A-005 (LOC ratchet) waits until seven
   open `agentModeService.ts` PRs shrink.
4. **Keep deploy units at four.** Agent-engine already extracted the
   Playwright workload and still JWT-calls `/api/internal/usage` (cycle 27).
   A fifth service for images/video would split the **leaf**
   (`imageGeneration.ts`: meter, C2PA L575–578, CRITICAL LOGO L477–484)
   from policy (category / HITL / persisted logo) and miss blog/thumbs/
   video/onboarding callers (cycle 36). It would also skip monthly quota
   (cycle 40) and pile onto the existing `fork` worker that already loads
   `AgentModeService` (cycle 44). Cycle 46: `generateImage` is already
   called from parent MCP, parent chatbot (`chatbotService.ts` L5461),
   and worker chat — a fifth HTTP process would be a client of both OS
   processes. Forbidden.
5. **Agent context map.** Draft: `research/sdlc/MODULE_MAP.md`. A short
   `backend/src/AGENTS.md` (module index, max file size, “do not edit X”)
   beats another 40k-line CLAUDE dump. LinkedIn’s 2026 MCP playbook is
   curated context, not every tool.

## Harsha gates

- Dynamo / `db.ts` (11.7k) is not a nanoservice candidate.
- Billing meter stays one success-path.
- Strangler PRs are his lane (Q-010 / A-003). Kevin’s unique help is
  still Hermes operator + MCP listing, plus *researching* this map.
