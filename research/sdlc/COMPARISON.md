# Code-quality comparison for agentic development

Snapshot: 2026-09-11T18:45Z, OMP DAG refreshed **18:58Z**. Hermes and OMP
via public GitHub; AgentWeb from this clone.

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
| OMP `@oh-my-pi/pi-agent-core` etc. | bun **packages/** | `packages/agent`, `ai`, `catalog`, `coding-agent`, `tui`, `natives` (Rust), `wire` |
| OMP largest TS | `packages/coding-agent/src/session/agent-session.ts` **445 KB** | They also have god files; they **contain** them in a package |
| OMP README claim | ~80k lines Rust core | `crates/pi-builtins`, `pi-shell` |

**Read:** OMP/Hermes are not “small files everywhere.” They are **bounded
packages** so a coding agent can open `packages/agent` without `db.ts`.
AgentWeb’s extracted `agentMode/core` is the right direction and is
incomplete; the monolith is still the default place to add features.

## Topology

```
Hermes:     CLI / gateway / ACP  ──► AIAgent ──► registry ──► tools/*.py
                                     (one process)               MCP as client

OMP:        coding-agent CLI    ──► pi-agent-core ──► pi-ai ──► pi-catalog
            (package.json this cycle: ai does **not** depend on agent-core)

AgentWeb:   customer-portal (other repo)
            partner-portal EB  ─┐
            backend EB        ─┼─► one Node process: 40k-line loop + 60 tools
            agent-engine VM    ─┤   MCP server is a *face* on that process
            remotion-lambda    ─┘
            creative leaf already matches OMP: loop → imageGeneration,
            never reverse. Folder-move (A-008) keeps that arrow.
```

## OMP workspace DAG (2026-09-11 `package.json`)

| Package | Depends on `@oh-my-pi/*` | Must not depend on |
|---|---|---|
| `pi-catalog` | omptype, pi-utils | agent-core, coding-agent |
| `pi-ai` | catalog, natives, utils, wire, omptype | **agent-core** |
| `pi-agent-core` | **pi-ai**, catalog, natives, utils, wire, snapcompact | coding-agent |
| `pi-coding-agent` | agent-core, pi-ai, tui, mnemopi, … | — |

AgentWeb mapping: `pi-ai` ≈ `imageGeneration.ts` + `llmClients.ts`;
`pi-agent-core` ≈ `agentModeService.ts`. The image arrow already matches.
The mismatch is `utils/llmClients.ts` importing `services/usageRecorderService`
(OMP `pi-utils` would not depend on the app). That is A-009, parked.

## Agentic SDLC practices

| Practice | Hermes / OMP | AgentWeb |
|---|---|---|
| Documented target loop | Yes | `AGENTMODE_MIGRATION.md` — **stale scorecard** (24k vs 40k) |
| Characterization tests | pytest volume | `backend/src/__tests__/agentMode/characterization/` exists |
| Eval / bench on tools | OMP “benchmaxxed” edits; metaharness package | `loops/` framework; human eval for images (not a router) |
| Module boundary in CI | package graph / documented import chain | **No** dependency-cruiser / eslint-plugin-boundaries |
| Skills as files | `skills/` + optional-skills | Skills in system prompt + DB `foundation_tools` |
| MCP | Client to many servers | Server wrapping the monolith |

## Implications (not a port)

- Do not copy Hermes’ Telegram adapter size into Emma.
- Do not copy OMP’s Rust natives.
- Do copy: **package boundaries, registry import DAG, section-file MCP
  (ENG-982) then one-tool-per-file later, keep the loop in-process, MCP
  as the *external* nanoservice bus.** Do not copy Hermes’ 1-file-per-tool
  as the *first* A-007 PR (`A-007-split-map.md`).
- `loops/core/ports.ts` is closer to OMP `pi-agent-core` than
  `agentModeService.ts` is. Promote that pattern; don’t invent K8s.
