# Cycle 017 — Architecture track: nanoservices vs modular monolith

UTC: 2026-09-11T18:45Z. Kevin asked to research breaking the repo into
nanoservices, compare Hermes / Oh My Pi for agentic-dev quality, and run
this continuously. `coding_unlocked` still false. Product READY set
**unchanged** (do not un-ready Q-001 / Q-014 / Q-003).

## File-level citations

1. **Already multi-runtime, not a single blob.** `.github/workflows/deploy.yml`
   path-filters `backend` vs `partner`. `agent-engine/` is a GCP VM.
   `remotion-lambda/` is a fourth unit. `local-agent-relay/` is dead
   (ENG-383). A “split the repo into nanoservices” program that ignores
   these four units is solving the wrong layer.

2. **The pain is in-process, not deploy.** `agentModeService.ts` **40,571**
   lines; June `AGENTMODE_MIGRATION.md` scorecard still lists **23,895**.
   `executeAgentStep` in `backend/src/services/agentMode/core/agentStep.ts`
   L48–55 **throws** (“skeleton — not yet wired”). Extracted
   `backend/src/services/agentMode/` is ~10k lines; the monolith still
   grew. Strangler without a ratchet is theatre.

3. **Gold standard already in-tree:** `backend/src/loops/README.md` +
   `loops/core/ports.ts` — host deps are ports; README says core has
   **zero imports from elsewhere**. Grep of `loops/` for `from '../../`
   is empty. `backend/package.json` has **no** dependency-cruiser /
   import-linter / eslint-plugin-boundaries. A-002 is that CI gap.

4. **Hermes (NousResearch/hermes-agent architecture.md):** one `AIAgent`
   process; `tools/registry.py` ← `tools/*.py` (self-register) ←
   `model_tools.py`. MCP is a **client**. Plugins are the large files
   (Telegram adapter ~392 KB), not the loop. This is a modular monolith
   + plugin nanoservices, not 70 HTTP services.

5. **Oh My Pi (`can1357/oh-my-pi` README packages table):** bun workspaces
   `@oh-my-pi/pi-agent-core`, `pi-ai`, `pi-catalog`, `pi-coding-agent`,
   `pi-natives` (Rust), `pi-wire`, `browser-relay`. Largest TS
   `packages/coding-agent/src/session/agent-session.ts` **445 KB** —
   they still have god files, **inside a package**. ~80k-line Rust core
   is natives/shell, not Emma-shaped marketing tools.

6. **Cutting-edge 2026:** Microsoft multi-agent reference architecture
   (modular monolith first). Nanoservice essays (telemetryagent.dev):
   logical one-operation modules, deploy boundary separate. LinkedIn
   QCon AI 2026: MCP as *curated context*, not every tool. AgentWeb MCP
   already is that bus; listing 60 admin tools is the opposite (Q-015).

7. **Q-013 remains discard.** HTTP-per-tool (A-006) would split
   `meterUserUsage` / C2PA / `logoImage` (PROTOCOL invariants).

## DISCARD / new items / ranks

- **A-006 DISCARD** — HTTP nanoservice per Emma tool.
- **A-001 READY** — thesis in `research/sdlc/THESIS.md`.
- **A-002 READY** — CI boundary on `loops/core`.
- **A-005 KEEP** — LOC ratchet; collision with #2861/#2871/#2832.
- **A-003 PARK** — same as Q-010.
- **A-004 PARK** — `emma/tools.ts` vs #2832.
- Product queue ranks **not rewritten**.

## Mapping evidence

New folder `research/sdlc/` + `COMPARISON.md` numbers.

## Next

Cycle 18: deeper SDLC — what a `backend/src/AGENTS.md` module map would
contain; whether `apiTools.ts` can be split without touching #2832;
refresh open-PR collision on `agentModeService.ts` only. Recurring timer
retargeted to this track until `stop_after` 2026-09-12T06:00:00Z.
