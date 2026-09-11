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
**skips it** (`mcpClientService.ts` L420–432) as a circular dependency.
Q-014 lists `generate_image` for *external* Hermes; it does not re-enable
that self-client. `ListTools` is `getToolDefinitions()` with **no skill
gate** (`mcpServerCore.ts` L76–83, cycle 48). Anonymous discovery
(cycle 49) may **list** that tool when the ENG-984 flag is on;
`ANONYMOUS_TOOLS` is empty so they cannot **run** it. Cycle 50: a leaked
`CallTool` still dies at `mcpFetch` `lookupUser` (`httpClient.ts` L57–66)
before a self-call JWT. Cycle 51: do not treat `requireEmmaTokenBudget`
as a substitute — it allow-lists `anon_*` (ENG-1163). The listed face is a
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
| Boundary linter | import chain documented | workspace packages | **None**. Cycle 42: at least six `services/` files import `controllers/` (A-013) |
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
