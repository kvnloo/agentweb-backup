# AgentWeb architecture — teach-in for Kevin

Findings and priorities first: [`README.md`](README.md).

Status: **cycle 6 teach-in**, refined through cycle 47. This is the map
behind the artifact.

## 1. What you forked

AgentWeb is a **billed, multi-tenant AI marketing operator**. The product
persona is **Emma** (CMO, not a generic chatbot). Customers talk to her in
the **customer portal** (separate GitHub repo, not in this tree). This repo
is backend + **partner-portal** (admin) + **agent-engine** (Python worker).

You forked `AgentWebPro/agentweb` on 2026-09-11. The people already shipping
here are Harsha (CEO), Fangfang (CPO), Matt (CMO), and Argusoft contractors
(CRM, ads plumbing, billing). Your comparative advantage is **Hermes, MCP,
arena-style model routing, and generative graphs** — not another CRM ticket.

## 2. Picture

```
customer-portal (other repo)  ─┐
partner-portal (admin, here)  ─┼─► Express API  :3001
                                │     JWT / delegate tokens
                                │     DynamoDB + S3
                                │
                                ├─ Agent Mode worker  (Emma chat, 60+ tools)
                                │     callLLM → OpenRouter (text/tool/vision)
                                │     SSE progress (not Socket.IO for the turn)
                                │
                                ├─ MCP  /mcp + /oauth
                                │     Hermes / Claude / Cursor as *clients*
                                │
                                ├─ Playwright MCP  @playwright/mcp@0.0.70
                                │     --headless --isolated  (per session)
                                │
                                └─ agent-engine  (GCP VM, Python)
                                     browser-use + Playwright
                                     polls AW-TaskExecutions, max 3 concurrent
```

## 3. The three runtimes you will actually touch

**Agent Mode** is the product. HTTP `POST /api/agent-mode/.../generate` →
`agentModeController` (session lock, timeouts, scheduled-chat policy) →
`generateMarketingResponseWorkerService` (fork) →
`agentModeService.generateMarketingResponse` (LLM ↔ tools). Progress is
**SSE** via `utils/sseProgress.ts` (legacy `onProgress` /
`RunEmitter.emitLegacy`). The typed `RunEmitter` sink is a no-op
(`agentModeService.ts` L3449; cycle 64). Socket.IO is the Emma
*sidebar* and some fanout (`user:` / `socket.id`) — not the Agent Mode
progress bus. The README picture is stale.

Gravity wells (do not "split the file" as a first PR):

| File | ~Lines | Role |
|---|---|---|
| `backend/src/services/agentModeService.ts` | 40.5k | Loop, model registry, image/video tools, billing hooks |
| `backend/src/controllers/agentModeController.ts` | 15k | Locks, scheduled chats, auto-continuation |
| `backend/src/emma/tools.ts` | 9.8k | In-process Emma tool schemas |
| `backend/src/mcp/server/apiTools.ts` | 3.6k | What Hermes sees (REST wrappers) |

A strangler already lives under `backend/src/services/agentMode/`
(dispatch, finalize, work-plan, streams). The target loop in
`AGENTMODE_MIGRATION.md` is explicitly "Claude-Code / Hermes / OpenClaw
shaped". That is **Q-010**, Harsha's lane, not your first PR.

**agent-engine** is the *other* product: classic "do this website task in
natural language." It is not Emma. OpenRouter is already wired
(`openrouter_gateway.py`). Cookie files sync to S3. Leave it unless ENG-381
becomes yours.

**Coding agent** (`codingAgentService.ts`) is a *sub-agent* Emma delegates
to for landing-page diffs. The 2026-03 "Emma can't edit files" write-up is
**stale for landing pages**. MCP still lists the deprecated
`edit_landing_page_file` and *tells clients to use `coding_agent`*, which is
**not registered on MCP**. That is Q-006.

## 4. Two tool registries (this is the Hermes trap)

| Registry | Loaded by | `generate_image` |
|---|---|---|
| `emmaToolRegistry` (`emma/tools.ts`) | Agent Mode / in-app Emma | Full schema, parallel-variants instruction, required `category` |
| `mcpToolRegistry` (`apiTools` + `workflowTools` + `evaluationTools`) | Hermes / OAuth / API keys | Hidden (`internal: true`). Video tools absent. |

`tools/list` drops `internal`. `internalOnly` also **refuses** execute for
`externalMcp` (ENG-974). Only four tools are `internalOnly` (blog, skills,
email). `post_on_account` and always-admin tools (`freeze_user_account`,
`list_all_clients`, `manage_user_notes`, …) are still listed. ListTools
has **no** `isAdmin` (cycle 9). `edit_landing_page_file` is listed and
points at missing `coding_agent` (Q-006).

ENG-982 added job-shaped `emma_*` tools (`emma_run_marketing_task`, …).
**ENG-983 will unlist the CRUD catalogue.** Do not do ENG-983 for them.

OAuth for MCP is done (ENG-1869). Remaining work is the **operator path**
(PTY + paste callback URL). See `briefs/Q-001-hermes-oauth.md`.

## 5. Skills vs work plans

From the product README, still true:

- **Skill** = how to use tools ("when posting to LinkedIn, stay under 1300
  chars"). Lives in `systemPrompt` + tool bundle. `install_skills` is how
  Emma loads them. Foundation tools are DB-overridable
  (`foundation_tools` in AW-Settings).
- **Work plan** = a sequenced outcome with gates (`requiredFunctionCalls`).
  Onboarding, GTM, "build the ads" are work plans.

If you can say it as "when using X, always Y" → skill. If you can say it as
"to achieve X, do A → B → C" → work plan.

## 6. Creative stack (your Comfy / arena overlap)

```
generate_image → imageGeneration.ts
  Azure GPT-image | Gemini | Runway gen4
  → C2PA strip → S3 → chat
  → enqueueAutoHumanEval (Matt, Slack)
```

Failover is a **static list** (`gpt-image-2` already first) and skips
explicit model / edits / logo. Human-eval stores **no `imageModel` field**
(only `Model:` in `outputSummary`). Onboarding like-rates score *prompts*,
not providers.

**DesignArena (Q-003) is the live router; Matt's queue is taste, not a
picker.** Cycle 8 proved `mcp-bench-router` cannot pick Emma providers
(OpenRouter chat map). The `image` leaderboard *does* share IDs:
`gpt-image-2` is #3 and $0.04; the hardcoded default
`gemini-3-pro-image-preview` is #22 and $0.134. Map with fail-open; do not
flip the production default until Matt says so. See
`mappings/designarena-image-models.md`. Cycle 12: `outputSummary` has
`Model: <id>` but feedback is untyped Slack — Q-002 is an offline parser
only (`mappings/eval-output-summary.md`), never a per-request scan.

Video: Seedance (Higgsfield) → Veo; Remotion `BrandedVideo` for brand
overlays. Cycle 10: that composition **already** has the lower-third intro
and CTA end card (`Root.tsx` has one id). HyperFrames (HTML→MP4) and
MoneyPrinterTurbo are not drop-in providers. Extra compositions: Q-007
parked. Video on MCP: Q-016, after Q-014. Comfy: Q-009.

**Do not touch:** `meterUserUsage`, C2PA default-on, `logoImage` preservation.

## 7. Three browsers

1. **Playwright MCP** in Agent Mode — headless, isolated, cookies in
   `AW-BrowserCookies`. Fine for landing-page QA. Cannot hold WhatsApp Web.
2. **agent-engine / browser-use** — cloud VM, S3 cookie jar, 3-wide. Same
   detection problem for locked-down social.
3. **local-agent-relay** — Codex + ngrok, **retired ENG-383**. Successor is
   **ENG-381**. That is Hermes-on-a-real-browser (Q-011, parked). Do not
   fight WhatsApp Cloud API PR #2271.

## 8. Money

Text models have Artificial Analysis quality scores, cost tiers, and
same-family dominance hiding. Usage runway already recommends cheaper models.
OpenRouter BYOK can report $0 — AgentWeb must still meter from the price
book (the only Kerdoios lesson worth stealing). **Do not port Kerdoios.**

Image/video are **not** on OpenRouter. They have their own price functions
and a single meter point on success.

## 9. Trust and merge gates

- `req.user` after delegation is the **customer**, not the admin.
- Never `localStorage.getItem("token")` in frontend; `useAuth()`.
- End-user UI goes in **customer-portal**, not partner-portal.
- **No Dynamo schema** without Harsha.
- Merge proof is `merge-evidence.sh`, not `gh pr checks` alone.
- Don't compete with open PRs #2862 (OpenRouter 429), #2271 (WhatsApp),
  #2861 (pdf tool).

## 10. How you help (queue)

READY, no schema. **Code in this order**, not by raw score:

1. **Q-001** — Hermes login runbook / skill (`briefs/Q-001-hermes-oauth.md`)
2. **Q-014** — list `generate_image` on MCP (`briefs/Q-014-generate-image-mcp.md`)
3. **Q-003** — DesignArena → `SUPPORTED_MODELS` (`briefs/Q-003-designarena-adapter.md`)
   Score is highest (38) because the arena evidence is now live, but a
   default flip has customer blast radius. Matt before production.

Hygiene READY (after the first three): **Q-004** hide MCP
`post_on_account` (land with Q-014); **Q-006** hide deprecated full-file
edit; **Q-015** hide always-admin tools.

Parked: Comfy backend (Q-009), extra Remotion compositions (Q-007 —
intro/outro already ship), MCP video (Q-016, after Q-014), Agent Mode
strangler, ENG-381 until Harsha says it's yours.

Customer-portal code is **not in this clone**. Anything you want to see in
the app UI needs the other repo.

## 11. Nanoservices vs modular monolith (cycle 17)

You asked whether to break this repo into nanoservices. **Deploy-layer
split already exists** (backend EB, partner-portal EB, agent-engine VM,
remotion-lambda). The 40.5k-line loop is an *in-process* problem.

Cutting-edge agentic SDLC (Hermes, Oh My Pi, Microsoft modular-monolith
guidance) is: **packages + ports in one process**, MCP as the *external*
bus, extract a fifth process only for scale or isolation. A HTTP
nanoservice per Emma tool would split billing/C2PA/logo and fight MCP.

In-tree gold standard: `backend/src/loops/core` (ports; no `services/`
imports; may import `loops/index` registry). Incomplete strangler:
`agentMode/core` (`executeAgentStep` still throws). MCP already started
the Hermes split (`workflowTools.ts`); `apiTools.ts` is 85 tools in one
file. Cycle 24: do not put Q-014 in a `content.ts` extract — Content
already imports `agentModeService`. Cycle 25: that MCP tool already
loopbacks `http://localhost` into `generateImage` (`COMPOSITION.md`).
Cycle 26: in-app path is `toolDispatch` → `executeTool` (no HTTP);
`codingAgentService.ts` is not a subprocess.
Cycle 27: agent-engine still JWT-calls `/api/internal/usage`; A-002
oracle is 18 `loops/core` files / two `../index` escapes.
Cycle 28: `awsAdapters.ts` is the host; do not copy Hermes
`discover_builtin_tools` into A-007.
Cycle 29: `mcp_config` `"agentweb-tools"` self-MCP is skipped as circular
(`mcpClientService.ts` L420–432).
Cycle 30: leaf callers skip `generateImage`; OMP is `@earendil-works/pi-ai`
0.85.1 (arrow unchanged).
Cycle 31: **#2563** appends remnant `not.toContain` checks to
`sdkConstructionGuard.test.ts`; A-002 copies walker L41–68 into a
sibling file, does not append. `apiTools.ts` / `imageGeneration.ts` /
`loops/core` still have no open PR.
Cycle 32: A-007 copies `workflowTools.ts` (mcpFetch); do not copy
`evaluationTools.ts` (in-process services + emma dual-register).
Cycle 33: A-008 is a **path shim** at `services/imageGeneration.ts`, not
`swarm/index.ts` (zero prod importers). `LoopPorts` (6 interfaces) is
the in-process composition bus.
Cycle 34: A-002 oracle is **20** `loops/core` files (35 specifiers, two
`../index` escapes). Q-014 drops `internal` at L2077 and edits
`mcp.apiTools.test.ts` L91 — not an `emma_generate_image` wrapper.
Cycle 35: `loops/index.ts` is Hermes `registry.py` (only `./core/types`).
`app.ts` L118–120 is the composition root. MCP `registry.ts` already
imports `evaluationPolicy`.
Cycle 36: C2PA default-on (`imageGeneration.ts` L575–578) and CRITICAL
LOGO (L477–484) are **leaf** invariants; policy owns category / HITL /
persisted logo. A-006 stays discarded.
Cycle 37: four in-process registries (`emma/registry.ts` is 3 lines).
Q-014 is `mcpServerCore.ts` L81–83 `getToolDefinitions()`, not an Emma
dual-register. A-005 pile still 7 PRs (40,571 vs scorecard 23,895).
Cycle 38: two `generate_image` executes (Emma `emma/tools.ts` L5055
direct vs MCP `apiTools.ts` L2096 mcpFetch). `backend/package.json` has
neither `workspaces` nor `dependency-cruiser`. First slice is folders +
AST, not npm workspaces.
Cycle 39: MCP schema is a thinner HTTP adapter (no `confirm` /
`metrics_verified`; `emmaApi.ts` L181). Q-014 stays list-only. A-011
parks schema unification.
Cycle 40: monthly quota is not in `generateImage`. MCP hop skipped the
controller (`emmaTokenBudget.ts` L4–10); `POST /generate-image` is
`metered` (L58). Auto-continuation copied `checkTokenUsage` again
(L1327–1334). A-006 stays discarded.
Cycle 41: `agentModeService.ts` L29894 imports `controllers/blog`.
A-012 parks lifting `generateBlogImage`. A-008 does not fix it.
Cycle 42: six services import controllers (`emmaEmailService.ts` L5
static `generateSessionResponse`). A-013 parks the family. A-002 still
must not walk `loops/instances/` (`rcaEnricher.ts` L25 / L227).
Cycle 43: those imports land on three exports (`runVerifiedChat` L5019,
`runScheduledChat` L5362, `generateSessionResponse` L7908). **#2393**
is the Slack channel-port extract — do not compete. A-006 discarded.
Cycle 44: `generateSessionResponse` L8256 `runInWorker` forks
`workers/generateMarketingResponseWorker.ts` (L16 `new AgentModeService()`).
MCP listing stays on the parent. Do not add HTTP on top of the fork.
Cycle 45: parent singleton (`server.ts` L6 / L594) still serves MCP
server + chatbot-without-fork; worker has no `setupMcpServer`. Q-014 is
parent `tools/list`. A-006 discarded.
Cycle 46: parent is I/O (cron `server.ts` L563, in-memory
`instanceState.ts` L10–11, Socket.IO); worker is compute
(`generateMarketingResponse`). Chatbot still `executeTool` on parent
(`chatbotService.ts` L5461). `generateImage` has three faces. A-006
discarded.
Cycle 47: those faces have **three catalogs**. MCP `internal` (Q-014
flips this). Chatbot `pageToolMap['images']` L5211. Agent Mode
`buildSkillContext` — `describe_image` is foundation (ENG-260),
`generate_image` is not. A-014 parked. Do not copy page/skill gates
onto Hermes `tools/list`. A-006 discarded.
Cycle 48: `ListTools` is `getToolDefinitions()` with no skill gate
(`mcpServerCore.ts` L76–83). Fork #2 / #3 in flight. A-007 waits on #2.
A-006 discarded.
Cycle 49: anonymous `tools/list` (flag default off) can see Q-014’s
tool; `ANONYMOUS_TOOLS` is empty so they cannot run it. A-015 parked.
A-006 discarded.
Cycle 50: leaked CallTool still dies at `mcpFetch` `lookupUser`
(`httpClient.ts` L57–66 / L169) before a JWT. ENG-822 does not fire.
A-006 discarded.
Cycle 51: Emma meter **allows** `anon_*` (`tokenUsageService.ts`
L293–305, $2 vs ChatSessions). `_svc` skips `getUserById`. Leaf meter
drops `no_user`. A-006 discarded.
Cycle 52: AgentWebPro still empty on `apiTools.ts` / `httpClient.ts` /
`anonymousTransport.ts` / `emmaApi.ts` / `tokenUsageService.ts` /
`imageGeneration.ts` / `loops/core`. `emma/tools.ts` still #2832 #1076
#689. `#2563` still owns `sdkConstructionGuard.test.ts`. A-006 discarded.
Cycle 53: MCP `generate_image` is `ctx(context)` (`apiTools.ts`
L2096–2098); `toolHelpers.ts` L10–22 drops `overrideToken`. ENG-1596
cannot skip `lookupUser` on this tool. A-007 keeps `ctx()`. A-006 discarded.
Cycle 54: `workflowTools.ts` L37/L248 is mixed-identity; do not copy that
import into `infrastructure.ts`. OMP 0.85.1 images stay in `pi-ai`.
A-006 discarded.
Cycle 55: `renderMediaOnLambda` L467 is the isolate; meter stays in
`remotionService`. `imageGeneration.ts` already calls vendor HTTP.
A-006 discarded.
Cycle 56: `mcp/client` ↛ `mcp/server` in prod (only test comments mention
the other folder). Shared `anonymousToolAccess.ts`. A-016 parked.
A-006 discarded.
Cycle 57: `app.ts` L204 `setupMcpServer` + L475–491 loop registers are
the composition root. **#2271** +7 WhatsApp routes on that file. A-007
does not touch `app.ts`. A-006 discarded.
Cycle 58: `drainForShutdown` (`server.ts` L404–413) waits before
`server.close()` because mcpFetch is this PORT. A-006 discarded.
Cycle 59: `crm.ts` L24 imports `io` from `server.ts` (ENG-1286
`instanceState.ts` L24–30). `registerIo` exists; `MinimalIo` cannot
`emit`. Worker L184 and `crmEnrichmentService` L67 `require('../server')`.
Park A-017. A-006 discarded.
Cycle 60: A-017 copies `fathomLinearPortRegistry` (register at
`server.ts` L44, get at `fathomWebhook.ts` L39). `chatSocketHandler`
L17–20 is the correct extract. Do not add `io` to `LoopPorts`.
A-006 discarded.
Cycle 61: 20 AgentWebPro PRs. Q-014 / A-002 / A-017 first-slice files
still empty. `crm.ts` #1544+#1790. `app.ts` #2271+#1814.
Cycle 62: only `server.ts` L186 `socket.join(\`user:${userId}\`)`. CRM
uses `socket.id`; codingAgent L1828 emits `sessionId` with no join.
A-017 is a passthrough. A-006 discarded.
Cycle 63: ten dynamic `await import('../server')` (gtmPlan L1495,
admin L4749, durableLanding L237, seven in agentModeController).
A-017 first slice is still the two `require`s. A-006 discarded.
Cycle 64: SSE (`sseProgress.ts`) ≠ Socket.IO. Worker IPC
`type:'progress'` vs `type:'socketEmit'`. `RunEmitter` typed sink is
a no-op. A-006 discarded.
Cycle 65: `sseProgress` Maps are parent-local (`workerService` L322).
Child worker never imports them. Chatbot is per-socket `message`
(`chatSocketHandler.ts` L94). A-006 discarded.
Cycle 66: `keyedMutex.ts` L12–15 — different processes never write the
same session. `tryClaimSessionGeneration` L936–956 is an in-memory
Set. A-006 discarded.
Cycle 67: MCP ENG-114 — no sticky routing; Dynamo metadata +
in-process rehydrate (`mcpSessionRehydration.ts` L3–8). A-006
discarded.
Cycle 68: ASG terminates before drain (`asgLifecycleGuard.ts`
L4–16). Hook `agentweb-drain-before-terminate` + `server.ts`
L572–574. Install is `eb-deploy.sh`, not `.ebextensions`
(ENG-818). A-006 discarded.
Cycle 69: `runDrain` L397–420 is four named drains. Inbound MCP
`CallTool` (`mcpServerCore.ts` L88–120) is not tracked.
`mcpShutdown` (`mcpServer.ts` L260–270) is unused by `server.ts`.
Q-014 stays ready. A-006 discarded.
Cycle 70: local `/mcp` (L307–315) vs `rehydrateAndServe` (L441)
share `CallTool`. Wrap once (`cronJobRegistry.ts` L1–9 names the
gap). A-006 discarded.
Cycle 71: 20 AgentWebPro PRs. CallTool-wrap files **empty**.
`emma/tools.ts` still #2832 #1076 #689. `app.ts` #2271 #1814.
`crm.ts` #1544 #1790. `agentModeService.ts` #2871 #2861 #2563
#2060 #1584. A-006 discarded.
Cycle 72: GET `/mcp` L508–531 `setTimeout(0)` SSE. Rehydrate has
no GET. Ordered: track CallTool, then `mcpShutdown`, then
`server.close()`. A-006 discarded.
Cycle 73: `server.close` / `io.close` L440–455 are callbacks, not
awaits. Guard L262–273 completes the hook when drain resolves.
`agentModeService.shutdown()` is MCP *client*. A-006 discarded.
Cycle 74: `workerShutdownGuards.ts` L1–18 / worker L9–13 ignore
SIGTERM (ENG-201). Parent `kill('SIGKILL')` L379–384 after
`pendingRequests`. A fifth `listen()` is not that child. A-006
discarded.
Cycle 75: `RecordLifecycleActionHeartbeat` never called. Hook
`--heartbeat-timeout 900` (`eb-deploy.sh` L612) + rolling.config
`Timeout: 900` sit above `DRAIN_CEILING_MS` 10 min. A-006 discarded.
Cycle 76: nginx `agent-mode-timeout.conf` L5–7 is global 600s;
`/socket.io/` is 3600s; ALB IdleTimeout 600; DeregistrationDelay is
`eb-deploy.sh` not `.ebextensions` (ENG-823). A-006 discarded.
Cycle 77: `httpClient.ts` L205 default 5 min; `generate_image`
L2096–2108 has no `timeoutMs`. v0 L1543 passes 25 min in-process.
A-006 discarded.
Cycle 78: `imageGeneration.ts` L69–79 default 8 min (ENG-510);
must stay under `GENERATION_TIMEOUT_MS` 10 min
(`agentModeController.ts` L1100–1101). MCP 5 min is stricter.
A-006 discarded.
Cycle 79: `emmaApi.ts` L174–187 no abort; meter L546–562 after
success. mcpFetch abort can still bill. A-006 discarded.
Cycle 80: `emmaApi` generate-image is outside
`tryClaimSessionGeneration`. `keyedMutex` is chatbot append only.
Quota is the MCP brake. A-006 discarded.
Cycle 81: that quota is `checkTokenUsage` then `next()`
(`emmaTokenBudget.ts` L171–196). Charge is `void meterUserUsage`
after vendor success; ADD does not refuse overshoot.
`reserveSpend` unused on this path. A-006 discarded.
Cycle 82: image `meterUserUsage` is `costUsdOverride` with 0
tokens. Default gate is tokens. A-006 discarded.
Cycle 83: SDK `streamId` per POST; OAuth 60/min is not in-flight;
rehydrate is one transport per request. A-006 discarded.
Cycle 84: `checkExtraCostUsage` tests-only; images do not write
`extraCostUsage`. A-006 discarded.
Cycle 85: default image $0.134; `gpt-image-2` $0.04; cost caps
are Dynamo. A-006 discarded.
Cycle 86: video same `$` / 0-token meter; not on MCP. Q-016
parked. A-006 discarded.
Cycle 87: AgentWebPro empty on `apiTools.ts` / meter files /
wrap set. `#2875` is cron. A-006 discarded.
Cycle 88: OMP 0.85.1 unpublished experimental client/server.
A-006 discarded.
Cycle 89: Hermes `mcp_tool.py` is still a client loader;
`mcp_tool_server_run.py` is remote-session lifecycle. Parallel
is `supports_parallel_tool_calls` default false. A-006 discarded.
Cycle 90: file-config still skips `"agentweb-tools"`
(`mcpClientService.ts` L420–432); Dynamo `mcp_servers` L435–450
does not. Admin `isValidUrl` allows localhost. Park A-018.
A-006 discarded.
Cycle 91: live face `/mcp` (`mcpServer.ts` L298); `/mcp/server`
is stale inspector + AGENT_API L129. Q-001 runbook is correct.
A-006 discarded.
Cycle 92: inspector `--transport sse` + `/mcp/server`. GET `/mcp`
SSE needs session id or 400. A-006 discarded.
Cycle 93: two SIGTERM listeners; `mcpShutdown` closes inbound
CallTool before `runDrain`. A-006 discarded.
Cycle 94: shutdown is local-only; `DELETE /mcp` is the only
`sessionStore.delete`. A-006 discarded.
Cycle 95: `MCP_SESSION_STORE` unset in git; default memory. A-006
discarded.
Cycle 96: Immutable deploys overlap two instances; MinSize=1 is a
comment, not `.ebextensions`. A-006 discarded.
Cycle 97: drain 503s scheduled chats only; `/health` and `/mcp`
stay 200 until unawaited `server.close`. A-006 discarded.
Cycle 98: `cronJobRegistry.drain()` is live; `track()` has no
gate. Worker already refuses new work. A-006 discarded.
Cycle 99: `chatbotTurn` already extends live drain; wrap preview
is in-app Emma, not a fifth `listen()`. A-006 discarded.
Cycle 100: Slack/email ack-then-track. Park A-019 (registry
gate). Do not edit `slack.ts` (#2393). A-006 discarded.
Cycle 101: `/generate` uses the session Set, not `track()`.
A-019 must close `tryClaim` too. A-006 discarded.
Cycle 102: auto-continuation re-fills the Set after release.
A-006 discarded.
Cycle 103: listed `emma_get_session` GET starts billed
continuation. A-006 discarded.
Cycle 104: `emma_send_message` 5 min hop around `/generate`;
abort cancels the inner turn. A-006 discarded.
Cycle 105: send_message POST is not retried after `server.close`;
GET `emma_get_session` retries 3× and still fails. A-006 discarded.
Cycle 106: inbound `/mcp` and loopback are different sockets;
`closeIdleConnections` unused. A-006 discarded.
Cycle 107: close() is nginx 502 now, not the 600s 504. A-006
discarded.
Cycle 108: ALB health cannot stop Hermes during drain; `/health`
must stay 200 until close. A-006 discarded.
Cycle 109: enhanced-health probe is deploy-verify, not drain.
A-006 discarded.
Cycle 110: weekly refresh overlaps without the deploy probe.
A-006 discarded.
Cycle 111: Sunday + Immutable do not stack a third backend.
A-006 discarded.
Cycle 112: 3×1200s settle is not a wait; `fail()` exits attempt 1.
A-006 discarded.
Cycle 113: last deploy’s hook dies with the Immutable ASG. Park
A-020. A-006 discarded.
Cycle 114: guard still drains without a hook; ASG does not wait.
A-006 discarded.
Cycle 115: Sunday SIGTERM is OS/cgroup, not the hook. A-006
discarded.
Cycle 116: journald is not the Node unit. A-006 discarded.
Cycle 117: `runDrain` never stops nginx. A-006 discarded.
Cycle 118: `PORT=8080` is not in git. A-006 discarded.
Cycle 119: cannot name platform nginx.conf (`app.ts` L152–155).
A-006 discarded.
Cycle 120: git never chooses among 3001 / 8080 / 5000. A-006
discarded.
Cycle 121: a `/mcp` location is instance-only; ENG-836 allows it
alone. Do not add A-021. A-006 discarded.
Cycle 122: detect-changes skips drafts (`tests.yml` L18); ENG-836
never sees a draft `/mcp` PR. A-006 discarded.
Cycle 123: re-draft is `NO_EVIDENCE` (`merge-evidence.sh` L264).
A-006 discarded.
Cycle 124: ENG-836 skip is not draft; conflict job is not the
discriminator. A-006 discarded.
Cycle 125: 5-minute string is the #2491 receipt; live ceiling
is 12; hung ENG-836 still does not block merge. A-006 discarded.
Cycle 126: in-flight ENG-836 is PENDING; cancel-in-progress turns
it into the cancelled PASS. A-006 discarded.
Cycle 127: ENG-1373 is still an unlanded comment; nothing in git
adds Backend build to GitHub required contexts. A-006 discarded.
Cycle 128: merge-evidence labels Dependabot skip as a path-filter
skip; #2491 PASSes with it skipped. A-006 discarded.
Cycle 129: GitHub treats a job-level `if` skip as Success;
Dependabot’s REQUIRED comment only bites when the job runs.
A-006 discarded.
Cycle 130: naming `Backend build` as required cannot reproduce
merge-evidence section 7. A-006 discarded.
Cycle 131: merge-evidence has no `PARTNER_JOBS`; a partner-only
PR PASSes with Partner skipped. A-006 discarded.
Cycle 132: no `WORKFLOW_JOBS`; editing `merge-evidence.sh`
PASSes with CI script tests skipped. A-006 discarded.
Cycle 133: ENG-1377 relay and remotion builds are unnamed in
merge-evidence. A-006 discarded.
Cycle 134: a `tests.yml` PR schedules six jobs; merge-evidence
requires `Backend build` only. A-006 discarded.
Cycle 135: agent-engine is a deploy unit with no GitHub build
job. A-006 discarded.
Cycle 136: customer-portal is a fifth repo (gitignored), not a
fifth process. A-006 discarded.
Cycle 137: the other repo’s IA is a typed list in this backend,
not an HTTP nanoservice. A-006 discarded.
Cycle 138: `growth-chat/` is a sixth origin; the loop already
shares `callLLM` in this process. A-006 discarded.
Cycle 139: Growth Genius is a fifth in-process catalog
(inline `search_knowledge_base` + Emma KB). A-006 discarded.
Cycle 140: `searchPlatformKnowledgeBase` is a leaf trapped in
a file that cycles with `agentModeService`. A-006 discarded.
Cycle 141: ENG-1057 already named three in-process KB faces;
the cap lives at the source. A-006 discarded.
Cycle 142: those faces do not share source sets. Agent Mode
is a Drive/ClickUp superset; Emma RAG and Growth Genius are
not. A-006 discarded.
Cycle 143: listed MCP `search_knowledge_base` already hops to
that Agent Mode superset; `generate_image` is still
`internal: true`. Q-014 is listing, not a new hop. A-006
discarded.
Cycle 144: Agent Mode still recaps Vertex after ENG-1057
capped the leaf; L24062 comment is stale. A-006 discarded.
Cycle 145: three TypeScript `searchKnowledgeBase` symbols;
Emma’s export is Azure embeddings, not the Vertex leaf.
A-006 discarded.
Cycle 146: same `search_knowledge_base` name, three JSON
schemas; GG requires `reason`. A-011 already parks this
pattern for `generate_image`. A-006 discarded.
Cycle 147: GG `reason` is required on the schema and
discarded before the Vertex leaf. A-006 discarded.
Cycle 148: GG and Emma RAG hardcode maxResults=10; Emma tool
/ MCP default 5. A-006 discarded.
Cycle 149: Agent Mode collects per source then slices;
Vertex-first prefix can discard Drive/ClickUp after paying
for them. Listed MCP hops here. A-006 discarded.
Cycle 150: Vertex filling the cap does not skip Drive or
ClickUp; no short-circuit after L24070. A-006 discarded.
Cycle 151: ClickUp docs “search” is list-all then
`includes()`; Drive already has `fullText contains`. A-006
discarded.
Cycle 152: `listTasks` enriches attachments; search only uses
name+description. A-006 discarded.
Cycle 153: `readDocContent` lists pages and may GET each page
before `includes()`; `nameMatch` does not skip the fetch.
A-006 discarded.
Cycle 154: Drive search has count+time bounds (ENG-1624);
`clickupService.ts` has zero TIMEOUT/MAX_MS/deadline. A-006
discarded.
Cycle 155: Drive folder trees `Promise.all` (L24080); ClickUp
docs walk sequential `await` per workspace then per doc
(L24148–24156). Drive file reads after the query are also
sequential (L24105). A-006 discarded.
Cycle 156: Search Drive/ClickUp helpers have no download
cap; materialize has 200MB (`L25626`); named-read truncates
to 1M after fetch. Search then keeps 5000 chars. A-006
discarded.
Cycle 157: Search Drive query omits `size` (`L24093`);
listing, named-read, and materialize request it. A-006
discarded.
Cycle 158: Workspace `files.export` has empty `size`;
named-read falls back to `contentStr.length` after download
(`L25606`). A-006 discarded.
Cycle 159: Hermes MCP client is ~24 in-process files; OMP
still v0.85.1. Registry still skips `mcp_tool.py`. A-006
discarded.
Cycle 160: Hermes loop still MCP client; two opt-in stdio
servers (`mcp_serve`, `hermes-tools`). A-006 discarded.
Cycle 161: Hermes `image_generate` on stdio MCP is
in-process `handle_function_call`. A-006 discarded.
Cycle 162: Hermes `image_generate` schema ≠ MCP
`generate_image`. Third origin after Emma vs MCP
(A-011). Do not add A-021. A-006 discarded.
Cycle 163: Hermes hides edit args the active model
cannot honor; AgentWeb MCP always lists them. A-006
discarded.
Cycle 164: Emma text says gemini-2.5-flash-image is
t2i-only; the leaf still takes the edit branch.
`validateParams` has no capability check. A-006
discarded.
Cycle 165: `logo_image` is mutated into `inputImages`
before model routing. A-006 discarded.
Cycle 166: Four image-model catalogs; L2203 “must match”
is false. A-006 discarded.
Cycle 167: HITL before leaf Invalid imageModel. A-006
discarded.
Cycle 168: Runway `referenceImages` from the mutated
array. A-006 discarded.
Cycle 169: Azure `/images/edits` `inputImages[0]` only;
logo-at-end drops. A-006 discarded.
Cycle 170: L492 default is Gemini 3 because multi-input;
Q-003 flip is still Matt-gated. A-006 discarded.
Cycle 171: Azure edit skips processInputImage. A-006
discarded.
Cycle 172: Azure FormData always image/png. A-006
discarded.
Cycle 173: S3 upload always image/png. Gemini 3
data-URL MIME is discarded at persist. A-006
discarded.
Cycle 174: Runway HTTPS skips C2PA and S3; meter
still fires. Cycle 36 L575–578 is after the data-URL
gate. A-006 discarded.
Cycle 175: generateWithOpenAI else unreachable. A-006
discarded.
Cycle 176: meter provider is prefix not dispatch;
gpt-image labelled openai while Azure is the vendor.
A-006 discarded.
Cycle 177: BLOG_SETUP.md is a stale fifth catalog
(OpenAI/Image + DALL-E 3 + Picsum). Blog heroes omit
imageModel → Gemini / Google/Image. Agent-engine still
has OPENAI_IMAGE_API_KEY. A-012 already parks the
controller import. A-006 discarded.
Map: `research/sdlc/A-007-split-map.md`.
Folder map: `research/sdlc/MODULE_MAP.md`. Services DAG:
`research/sdlc/SERVICES_DAG.md`. Full thesis: `research/sdlc/THESIS.md`.
