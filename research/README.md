# AgentWeb research artifact

**Do not explode Emma into HTTP nanoservices.** AgentWeb already has four
deploy units. The pain is a 40k-line god object, not missing Kubernetes.
Hermes and Oh My Pi win on **in-process packages and one tool catalog**,
not on a tool-per-HTTP mesh.

Coding is unlocked. First product PRs are **in flight**:
[Q-014 + Q-004](https://github.com/kvnloo/agentweb/pull/2),
[A-002](https://github.com/kvnloo/agentweb/pull/3). Q-001 is Kevin
Hermes smoke (existing runbook). Q-003 waits on Matt before a default flip.

---

## Priorities (implementation order, not score)

### Product

| Order | ID | Do this | Do not |
|---|---|---|---|
| 1 | **Q-014** | Drop `internal: true` on MCP `generate_image` (`apiTools.ts` L2077). Test: `mcp.apiTools.test.ts` L91. Metering unchanged. **In flight: [kvnloo#2](https://github.com/kvnloo/agentweb/pull/2).** MCP `ListTools` is `getToolDefinitions()` with no skill gate (`mcpServerCore.ts` L76–83). | Dual-register like `evaluationTools`. Unify Emma vs MCP schema (`confirm`). Add to `DEFAULT_FOUNDATION_TOOLS`. Copy chatbot page-gating. Add to `ANONYMOUS_TOOLS` (A-015). |
| 1b | **Q-004** | Same PR or before: `internal` + `internalOnly` on MCP `post_on_account` only | Edit `emma/tools.ts` (#2832). Unlist `manage_*` (ENG-983). |
| 2 | **Q-001** | Kevin OAuth smoke on `HERMES_MCP_OAUTH.md` (315s PTY). Parent already refreshes OAuth (`server.ts` L586). | Rewrite the in-repo runbook unless smoke finds a lie. |
| 3 | **Q-003** | Fail-open DesignArena → `SUPPORTED_MODELS`. Live: `gpt-image-2` image **#3 / $0.04**, logo **#1**. Hardcoded default `gemini-3-pro-image-preview` is image **#22 / $0.134**, logo **#40**. | Flip prod default without Matt. Add Riverflow / `gpt-image-2.5` in the first slice. |
| hygiene | Q-006 / Q-015 | Hide `edit_landing_page_file` and admin MCP tools | — |

None of the first slices needs a Dynamo table.

### Architecture (after or beside Q-014, not instead)

| Order | ID | Do this | Do not |
|---|---|---|---|
| 1 | **A-002** | New `loopsCoreImportGuard.test.ts` on `loops/core` + `loops/index.ts`. **In flight: [kvnloo#3](https://github.com/kvnloo/agentweb/pull/3).** | Append to `sdkConstructionGuard.test.ts` (#2563). Walk `loops/instances/` (`rcaEnricher` imports `agentModeService`). |
| 2 | **A-007** | `mcp/server/tools/infrastructure.ts` copying `workflowTools.ts` | Copy `evaluationTools.ts`. First file is **not** `content.ts`. Edit `emma/tools.ts`. |
| 3 | **A-008** | `git mv` `imageGeneration.ts` → `services/creative/` + path shim | HTTP-split the leaf. |

**Discarded:** A-006 (HTTP nanoservice per tool). **Parked:** A-013 — do not start at Slack (`AgentWebPro#2393` owns `conversation/channelPort`). **A-017** — stop CRM/worker importing `server.ts`; expand `sessionSockets` emit (not `crm.ts`, not LoopPorts).

---

## Findings (cycles 17–47)

### 1. Four deploy units already exist

Backend EB, partner-portal EB, agent-engine GCP VM, remotion-lambda.
A fifth process for images would split **policy** (`generateImage`:
category / HITL / persisted logo) from the **leaf** (`imageGeneration.ts`:
meter, C2PA default-on, CRITICAL LOGO) and miss blog / thumbs / video /
onboarding callers.

### 2. The EB box already forked — that is I/O vs compute, not a package

| Process | Role |
|---|---|
| Parent | HTTP, Socket.IO, in-memory cron, MCP **server**, OAuth refresh, Emma chatbot |
| Worker | `new AgentModeService()` then `generateMarketingResponse`. No Socket.IO (`socketEmit` IPC). |

Same 40k class on both sides. Hermes keeps sockets **and** the loop in one
process. Oh My Pi stays in-process packages (`pi-ai` ↛ `pi-agent-core`).

### 3. `generate_image` is one name, three faces, three catalogs

| Face | Process | How it runs | Who sees it |
|---|---|---|---|
| MCP (Q-014) | Parent | `mcpFetch` → `/api/emma/generate-image` → policy | Hidden by `internal: true` until Q-014. No page, no skill. |
| Emma chatbot | Parent | `executeTool` in-process (no fork) | Injected on the `images` page only |
| Agent Mode | Worker | emma registry → `generateImage` | Skill / `__other_skills__`. **Not** foundation (`describe_image` is). |

MCP schema is thinner (no `confirm`). Quota is per-face, not in
`generateImage`. Do not HTTP-split this method — both OS processes would
become clients of a fifth hop.

When `MCP_ANONYMOUS_DISCOVERY=true` (default **off**), anonymous
`tools/list` will include listed `generate_image`. `ANONYMOUS_TOOLS`
is empty — look but not run (`anonymousTransport.ts`). Do not add
`generate_image` to that set (A-015). If that allowlist leaked,
`mcpFetch` `lookupUser` still throws `User not found` **before** minting
a self-call JWT (`httpClient.ts` L57–66 / L169) — no leaf, no vendor.
ENG-822 does not rewrite that error (`generate_image` has no
`requiresUserAccount`). Copying `emmaApi` “because it is metered” is
not a spend door: `checkTokenUsage` **allows** `anon_*` under a $2
ChatSessions cap (`tokenUsageService.ts` L293–305) and `_svc` JWTs skip
`getUserById` (`auth.ts` L155–167). The leaf `meterUserUsage` is
fire-and-forget and drops `no_user` (cycle 51). Cycle 53: MCP
`generate_image` uses `ctx()` and cannot take the ENG-1596
`overrideToken` skip; chatbot/ishare `$2` is a different face.
Cycle 54: A-007 copies `workflowTools` **shape**, not its
`adminClientScope` import. OMP 0.85.1 still keeps images in `pi-ai`.
Cycle 55: remotion-lambda is the isolate; `imageGeneration.ts` is already
the host adapter (vendor HTTP). Do not copy the Lambda process onto images.
Cycle 56: MCP client/server folders are already acyclic (OMP DAG). Park
A-016 until A-002. Do not HTTP-split them. Cycle 57: **#2271** owns
`app.ts` route table; A-007 still attaches at `mcpServerCore` not `app.ts`.
Never compete with #2271 / #2862 / #2861.
Cycle 58: `server.ts` drain (ENG-1189) proves mcpFetch is loopback to this
`listen()`. A fifth image process would need a copy of that drain.
Cycle 59: `app.ts` → `crm.ts` L24 → `server.ts` already cycles. `registerIo`
exists; `MinimalIo` is password-change `fetchSockets` only, so worker
L184 and `crmEnrichmentService` L67 still `require('../server')`. Park
A-017 (expand emit; do not HTTP-split CRM; do not edit 7,815-line
`crm.ts` while #1790 is open). Cycle 60: that expand is
`getFathomLinearPort`, not `LoopPorts`. `chatSocketHandler.ts` L17–20
already extracted the right direction (`server.ts` L18 imports the
handler). Cycle 62: the only `socket.join` is `server.ts` L186
(`user:${userId}`). CRM emits to `socket.id`; codingAgent L1828 emits
`sessionId` with no join. A-017 is a passthrough, not a room enum.
Cycle 63: `gtmPlan.ts` L12–13 already documents dynamic
`import('../server')` to dodge the static cycle; L1495 still loads
the listen module. Same at admin L4749, durableLanding L237, and
**seven** `agentModeController` sites (`session-message-appended` to
`user:`). Partner-portal `GTMPlans.tsx` L292–300 listens with no
client join — server L186 is enough. A-017 first slice stays the two
`require`s, not the 15k controller. Cycle 64: Agent Mode progress is
**SSE** (`sseProgress.ts` L43, controller L8282–8284 / L7791), not
Socket.IO. Worker IPC already has two types (`progress` vs
`socketEmit`). `RunEmitter` (`streamEvents.ts`) typed sink is empty
(`agentModeService.ts` L3449); only `emitLegacy` runs. Do not absorb
SSE into A-017. Do not HTTP-split either bus. Cycle 65: those SSE
Maps are parent-instance-local (`sseProgress.ts` L10–14;
`instanceState.ts` L10–11 same shape). Child worker never imports
them; parent `clearTerminalProgress` L322 on worker death. Chatbot
is `chatSocketHandler.ts` L94 `socket.emit('message')` — a third
fanout, still this process. MCP `text/event-stream` Accept
(`mcpSessionRehydration.ts` L40) is Streamable HTTP, not Agent Mode
progress. Cycle 66: concurrency is the same shape.
`keyedMutex.ts` L12–15 states different processes never write the
same session; `tryClaimSessionGeneration` L936–956 is an in-memory
Set. Do not extract `generateImage` out from under that claim.
Cycle 67: that claim is **per-instance**. MCP ENG-114 already
handles “no sticky routing” by Dynamo metadata + in-process
rehydrate (`mcpSessionRehydration.ts` L3–8 / `mcpSessionStore.ts`
L7–19). Do not HTTP-split images to copy that. Do not copy the
MCP session table onto generate locks (Harsha). Cycle 68: even
that in-process work is killed on deploy unless `asgLifecycleGuard`
parks the ASG (`asgLifecycleGuard.ts` L4–16 / `server.ts` L572–574).
A fifth image process would need its own hook + `eb-deploy.sh`
install (ENG-818: not `.ebextensions`). Cycle 69: even on this
process, inbound MCP `CallTool` is not in the four-way wait list
(`server.ts` L397–420 vs `mcpServerCore.ts` L88–120). Q-014
`generate_image` mcpFetchs localhost; chatbot was wrapped
(`chatbotTurn`); MCP was not. Do not HTTP-split to “fix” drain.
Cycle 70: local `/mcp` reuse vs ENG-114 rehydrate are two faces of
the same untracked `CallTool`. Wrap `mcpServerCore`, not a fifth
process. Cycle 71: that wrap set is empty on AgentWebPro (20 PRs).
Do not compete on `emma/tools.ts` / `app.ts` / `crm.ts`.
Cycle 72: GET `/mcp` keep-alive SSE (`mcpServer.ts` L508–531) is
why `mcpShutdown` follows the wait. Rehydrate has no SSE. Do not
HTTP-split the stream.
Cycle 73: even after that order, `server.close()` is not joined
(`server.ts` L440–446). The ASG hook (`asgLifecycleGuard.ts`
L262–273) treats drain resolve as “instance may terminate.” Do not
HTTP-split to get a second close() to forget to await.
Cycle 74: the existing fork is protected by
`workerShutdownGuards.ts` (ignore SIGTERM, parent SIGKILL,
ENG-201). A fifth image process would receive the cgroup SIGTERM
and die — the failure that file exists to prevent. Q-014 is
parent MCP, not the worker.
Cycle 75: `RecordLifecycleActionHeartbeat` is IAM-only
(`asgLifecycleGuard.ts` L26). The 900s ASG hook and EB rolling
`Timeout: 900` (`.ebextensions/rolling.config` L5–7) are stacked
above a 10 min drain ceiling. A fifth process is in none of those
clocks.
Cycle 76: GET `/mcp` is the global nginx 600s path
(`.platform/nginx/conf.d/agent-mode-timeout.conf` L5–7), not
`/socket.io/` 3600s. ALB IdleTimeout 600. DeregistrationDelay is
the deploy script (ENG-823), same pattern as the ASG hook.
Cycle 77: Q-014’s inner mcpFetch aborts at 5 min
(`httpClient.ts` L205) unless `timeoutMs` is set. `generate_image`
does not set it. Do not HTTP-split to get a longer clock; v0
already overrides `timeoutMs` on this hop.
Cycle 78: the leaf allows 8 min (`imageGeneration.ts` L69–79
ENG-510) so a hung provider leaves 2 min under the 10 min turn.
MCP’s 5 min abort is stricter than that leaf. Align `timeoutMs`
on mcpFetch after listing; do not extract a process to get the
8 min.
Cycle 79: that 5 min abort does not cancel `generateImage`
(`emmaApi.ts` L174–187) and does not skip the leaf meter
(L546–562). Do not HTTP-split to get a cancel protocol; do not
touch billing.
Cycle 80: that orphan leaf is also **unclaimed**.
`tryClaimSessionGeneration` is Agent Mode only. MCP generate_image
has quota (`requireEmmaTokenBudget`), not the session Set.
Q-014 lists the tool; it does not add a lock. Do not HTTP-split
to get one.
Cycle 81: that quota is **check-then-act**.
`requireEmmaTokenBudget` GETs `checkTokenUsage` then `next()`.
`meterUserUsage` is `void` after vendor success; ADD conditions
on month, not remaining allowance. `spendChargingService`
reservation exists; admission is Harsha and unused here. Two
parallel Hermes `CallTool`s can both pass. A fifth process
copies the GET. Do not wire a reservation onto Q-014.
Cycle 82: that GET is the **token** dimension by default.
The leaf meters `$` with 0 tokens (`imageGeneration.ts` L551–563).
`ENFORCE_COST_CAP` is observe-only unless flipped or a versioned
policy enforces cost. `spendChargingService` has zero production
callers. Q-014 still lists into `metered` middleware; do not flip
billing to “fix” A-006.
Cycle 83: the MCP server does not serialize `CallTool`. SDK
Streamable HTTP mints a `streamId` per POST; OAuth 60/min is a
count window; ENG-114 rehydrate is one transport per in-flight
request. Hermes’ loop is the concurrency bound. Do not HTTP-split
to get a lock.
Cycle 84: `checkExtraCostUsage` has zero production callers.
Images do not write `extraCostUsage` (CRM enrichment does).
Do not wire that dead API onto Q-014.

### 4. Hermes / Oh My Pi vs this tree

| Practice | Hermes / OMP | AgentWeb |
|---|---|---|
| Agent loop | One process, packages | 40,571-line `agentModeService.ts` |
| Tool catalog | One registry / `tools/list` | Four in-process registries + three availability policies |
| MCP | **Client** to other servers | **Server** for Hermes *and* client to vendors; self `"agentweb-tools"` skipped |
| Extract | MCP outbound; OMP packages | Fork for health checks; DAG inverted (`services/` import `controllers/`) |

Cutting-edge 2026 (Microsoft modular-monolith first): folders + AST
guards, then extract. `backend/package.json` has **no** `workspaces`
and **no** `dependency-cruiser`.

### 5. What not to compete with (AgentWebPro)

`emma/tools.ts`: **#2832 #1076 #689**. `sdkConstructionGuard.test.ts`: **#2563**.
`agentModeService.ts` pile: **#2871 #2861 #2832 #2563 #2060 #1584 #1076**.
Slack: **#2393**. Never #2862 / #2271 / #2861. `#1076` also touches
`chatbotService.ts`. `#2861` is promoting `convert_to_pdf` to foundation
— do not piggyback `generate_image`. Cycle 57: still empty on
`apiTools.ts` / `loops/core`. **#2271** owns `app.ts` (+7 WhatsApp) plus
`slackChannelAdapter.ts` and `db.ts`. Cycle 61: **#1814** also edits
`app.ts` (HubSpot `crmSync`). A-007 does not touch `app.ts`.
`crm.ts` is **#1544 + #1790** — A-017 first slice is not that file.

---

## Invariants

Billing meter / `llmPricing`. C2PA default-on in the **leaf**. Brand
`logoImage` / CRITICAL LOGO in the **leaf**. No Dynamo schema without
Harsha. No `localStorage.getItem("token")`. End-user UI only in
**customer-portal**.

## Read next

| If you want | Open |
|---|---|
| Teach-in | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Product queue + briefs | [`QUEUE.md`](QUEUE.md), [`briefs/`](briefs/) |
| Architecture thesis | [`sdlc/THESIS.md`](sdlc/THESIS.md) |
| Hop diagram | [`sdlc/COMPOSITION.md`](sdlc/COMPOSITION.md) |
| Hermes / OMP comparison | [`sdlc/COMPARISON.md`](sdlc/COMPARISON.md) |
| Cycle receipts | [`cycles/`](cycles/) |

Rollback: delete `research/`.
