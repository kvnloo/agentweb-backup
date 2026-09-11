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
            chatbot on parent   ──► still executeTool (cycle 46; hexagon leaks)
```

## OMP workspace DAG (live 2026-09-11T19:17Z `earendil-works/pi` **0.85.1**)

Cycle 20 used `@oh-my-pi/*`. npm scope is now `@earendil-works/*`. Arrow
unchanged: `pi-ai` does **not** depend on `pi-agent-core`.

| Package | Depends on `@earendil-works/*` (0.85.1) | Must not depend on |
|---|---|---|
| `pi-ai` | pi-telemetry; **no** agent-core | **agent-core** |
| `pi-agent-core` | **pi-ai**, chord, pi-telemetry | coding-agent |

Cycle 20 catalog/utils/wire names may have folded into this publish; the
AgentWeb mapping does not need them. `pi-ai` ≈ `imageGeneration.ts`;
`pi-agent-core` ≈ `agentModeService.ts`.

## Agentic SDLC practices

| Practice | Hermes / OMP | AgentWeb |
|---|---|---|
| Documented target loop | Yes | `AGENTMODE_MIGRATION.md` — **stale scorecard** (24k vs 40k) |
| Characterization tests | pytest volume | `backend/src/__tests__/agentMode/characterization/` exists |
| Eval / bench on tools | OMP “benchmaxxed” edits; metaharness package | `loops/` framework; human eval for images (not a router) |
| Module boundary in CI | package graph / AST `discover_builtin_tools` | **No** (A-002 sketch only) |
| Skills as files | `skills/` + optional-skills | Skills in system prompt + DB `foundation_tools` |
| MCP | Client (`mcp_tool.py` skipped by discover) | Server for Hermes **and** client to vendors; self `"agentweb-tools"` **skipped** (`mcpClientService.ts` L420–432) |

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
