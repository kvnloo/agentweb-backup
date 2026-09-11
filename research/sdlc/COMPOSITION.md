# Composition hops (research only)

Cycle 25. How AgentWeb *already* composes, vs a nanoservice mesh.

Hermes uses MCP as a **client** to other servers. AgentWeb’s MCP is a
**server** whose tools `mcpFetch` themselves on loopback. That is the
external composition bus. A fifth process would add a hop *after* the
policy object that owns metering, C2PA, and `logoImage`.

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
imageService.generateImage  (meter + C2PA inside the leaf / recorder)
```

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
`onboardingAdImageService.ts`. An HTTP mesh in front of `emmaApi` would
not see them. A-008 re-export does.

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
| **A-006 HTTP image process** | **Yes** — after L28857 or instead of it | Would split category / HITL / logo / budget |

A-008 re-export pattern already in-tree: `services/swarm/index.ts`
(`export * from './…'`). Do **not** rewrite `emmaApi.ts` in that PR.

## Hermes / OMP vs this hop

- Hermes tools run in-process next to `run_agent.py`; MCP is outbound.
- OMP `pi-ai` is an in-process package; no localhost self-call.
- AgentWeb already paid for an HTTP composition layer (`mcpFetch`) **and
  still** lands in `agentModeService`. Copying Hermes’ MCP-as-client or
  exploding that loopback into Kubernetes does not shrink the 40k file.
