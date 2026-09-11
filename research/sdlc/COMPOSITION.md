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

`remotion-lambda` is the other extract (GPU/time-bounded render), invoked
in-process from `remotionService.ts` via `@remotion/lambda` — not a
second Emma mesh.

## MCP client + server (cycle 29)

Hermes: MCP **client** to other servers; tools stay in-process.

AgentWeb: MCP **server** (`mcp/server`, loopback `mcpFetch`) *and* MCP
**client** (`mcp/client/mcpClientService.ts`) to GitHub/Playwright/Higgsfield.
`mcp_config.ts` L3–10 still names `"agentweb-tools"` → `http://localhost/mcp`.
`initialize()` L420–432 **skips `isInternal`** so Emma does not MCP-call
herself. That skip is the in-tree rejection of A-006. Vendor MCP
(`excludeFromAgent`, Higgsfield) stays; do not invent a fifth process for
image gen.

Cycle 34: `httpClient.ts` L63 `lookupUser` → `await import('../../services/db')`.
A-007 `tools/infrastructure.ts` still mcpFetchs through that client.
File split ≠ `loops/core` package. Do not forbid db in `mcp/server`.

Cycle 35: in-process composition root is `app.ts` L118–120 (explicit
instance `register*`), not `loops/index.ts` (Hermes registry: types only).
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
