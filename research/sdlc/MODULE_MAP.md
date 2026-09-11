# Backend module map (research draft of `backend/src/AGENTS.md`)

Not in `backend/src` yet — research-only. Cycle 18. LOC is production
`.ts` excluding `*.test.ts` and `__tests__` (2026-09-11T18:50Z).

## Deploy units (do not add a fifth)

| Unit | Tree | Ship |
|---|---|---|
| API / Emma / MCP | `backend/` | Elastic Beanstalk |
| Admin UI | `partner-portal/` | Elastic Beanstalk |
| Classic web tasks | `agent-engine/` | GCP VM |
| Branded video | `remotion-lambda/` | Lambda |

Customer UI is **another GitHub repo**.

## `backend/src` folders (logical packages)

| Folder | Prod LOC | Files | Allowed to import | Must not become a process |
|---|---|---|---|---|
| `services/` | 217,708 | 412 | `utils`, `config`, `types`, `loops` (sensors) | No — this *is* the app |
| `services/*.ts` (root) | **201,295** | 348 | — | God-file pile; strangler target |
| `services/agentMode/` | 10,167 | 37 | ports into the monolith | Keep in-process |
| `routes/` | 59,572 | 121 | `services`, `middleware` | HTTP edge, not a service mesh |
| `controllers/` | 26,852 | 20 | `services` | Same process as routes |
| `utils/` | 23,312 | 133 | little | Shared lib |
| `emma/` | 15,008 | 24 | `services`, `mcp/server` | In-app registry |
| `mcp/` | 9,665 | 23 | `services` via REST (`mcpFetch`) | **External nanoservice bus** |
| `loops/` | 8,864 | 46 | adapters → AWS; **core via ports**; instances may import `db` / `callLLM` | Already a package |
| `cron/` | 7,415 | 19 | `services`, `loops` | Same Node process |

Hottest edges: `routes → services` (398), `services → utils` (250),
`emma → services` (38), `mcp → services` (17). MCP is supposed to go
through REST (`apiTools.ts` header: no direct service calls). **Cycle 24:**
that header is already false — four `await import('../../services/agentModeService')`
in Content + install_skills (L1406, 1442, 1970, 1991), plus static
`workPlanSteps` / `prDigestService`. Do not open more back doors. Do not
move the Content section in A-007’s first slice.

## What a coding agent should open

| Task | Open first | Do not open |
|---|---|---|
| MCP list / hide / generate_image | `mcp/server/apiTools.ts` L1996–2146 (infrastructure island) + `registry.ts` | `emma/tools.ts` while #2832 is open; do not open Content L1381 |
| Loop termination / dispatch | `services/agentMode/core/*` | Adding to `agentModeService.ts` unless net-negative |
| Closed-loop policy | `loops/core` + `loops/instances/<id>` | `agentModeService.ts` |
| Billing / C2PA / logo | stop | `usageRecorderService`, `imageGeneration.ts` logo path |

## `loops/core` boundary (A-002 nuance)

README: zero host imports. **True for `services/` / `db.ts`.** Core
*does* import `loops/index.ts` (registry) from `orchestrator.ts` and
`instanceRunner.ts` — documented as deliberate. CI should forbid
`loops/core/**` → `services|emma|db`, and **allow** `core → ../index`.
Cycle 35: `loops/index.ts` itself may only import `./core/types`.
`app.ts` L118–120 is the composition root (explicit instance register).

## MCP files (Hermes analog)

| File | Role |
|---|---|
| `loops/index.ts` | **Hermes `registry.py` analog** (types only; cycle 35) |
| `mcp/server/registry.ts` | **Not** that analog — imports `evaluationPolicy` L1 |
| `apiTools.ts` | **85** `register()` calls, 3.6k lines, section comments already name packages |
| `workflowTools.ts` | ENG-982: **5** mcpFetch tools, zero service imports. **A-007 template.** |
| `evaluationTools.ts` | 1 tool; **direct** `evaluationStore` / `evaluationService`; dual-registers onto `emmaToolRegistry` (L62). **A-007 anti-template** (cycle 32). |
| `mcpServerCore.ts` | side-effect `import './apiTools'` etc. Stale comment: “All 30 tools” (85+5+1) |

`emma/tools.ts` L7240 side-effect-imports `apiTools` to bridge scheduled-chat
tools. A split **must keep** `apiTools.ts` (or `apiTools/index.ts`) as the
barrel those tests and that bridge import.

## Proposed in-process packages (not HTTP)

See `SERVICES_DAG.md` for `services/` clusters. Cheap folder: `creative/`
(`imageGeneration.ts` is a leaf: no `db.ts`, 5 prod importers). Do not
move `db.ts` or `agentModeService.ts`.

```
mcp/server/tools/session.ts
mcp/server/tools/tasks.ts
mcp/server/tools/schedules.ts
mcp/server/tools/crm.ts
mcp/server/tools/landing.ts
mcp/server/tools/infrastructure.ts  ← generate_image, send_email, search (Q-014)
mcp/server/tools/blog.ts           ← create/publish blog; PARK (imports agentModeService)
mcp/server/tools/admin.ts
mcp/server/apiTools.ts             ← barrel: import './tools/infrastructure' (first slice)
```

That is ENG-982 section-files (not an 85-file Hermes clone) + OMP packages,
without a new deploy unit. Full map: `A-007-split-map.md`.
