# AgentWeb research loop

Living research system for this fork (`kvnloo/agentweb`, parent `AgentWebPro/agentweb`).
It does **not** ship product code. It scans the tree, maps Kevin's adjacent work,
and keeps a ranked feature queue that gets re-triaged every cycle until we
are ready to implement.

## What this is

| Artifact | Role |
|---|---|
| `PROTOCOL.md` | Scoring, KEEP/DISCARD, collision rules, what not to touch |
| `CONTEXT.md` | Kevin's other repos/experiments mapped onto AgentWeb |
| `ARCHITECTURE.md` | Living architecture brief (filled over cycles, then used to teach) |
| `QUEUE.md` | Human-readable ranked queue |
| `queue.json` | Machine-readable queue (source of truth for ranks) |
| `STATE.md` | Current cycle, next focus, stop conditions |
| `cycles/` | Dated analysis receipts |
| `briefs/` | Deeper implementation sketches for READY items |

## Operating rules

1. **Research first.** No product implementation until `STATE.md` says `coding_unlocked: true` and a queue item is `READY`.
2. **Re-rank every cycle.** New evidence can promote, demote, or DISCARD.
3. **One wedge.** Prefer work only Kevin is uniquely positioned to do. Do not compete with the Argusoft contractors on CRM/Meta/billing plumbing.
4. **No database/data-plane proposals** without an explicit Harsha gate note. AgentWeb merge rules treat schema as a hard stop.
5. **Collision check.** Open PRs on `AgentWebPro/agentweb` beat a duplicate idea.

## Cycle procedure (for the timer agent)

1. Read `STATE.md`, `PROTOCOL.md`, `queue.json`.
2. Pick the next `focus` subsystem (or continue a parked deep-dive).
3. Gather evidence from code, docs, open PRs, and adjacent repos.
4. Write `cycles/NNN-<slug>.md`.
5. Update `queue.json` then regenerate the top of `QUEUE.md`.
6. Update `ARCHITECTURE.md` only where the cycle actually taught something.
7. Commit, push, update the PR.
8. If UTC now > `stop_after`, unsubscribe `agentweb-research-cycle`.
   Do not unset `briefing_ready`. Do not set `coding_unlocked` unless
   Kevin asked to code. Initialization is already complete
   (`STATE.md` `initialization_complete`).

## How Kevin should use this

`briefing_ready` is **true**. Read `ARCHITECTURE.md` then `HOW_TO_HELP.md`.
`coding_unlocked` is still false until you ask to code. READY briefs:

- `briefs/Q-001-hermes-oauth.md`
- `briefs/Q-014-generate-image-mcp.md`
- `briefs/Q-003-designarena-adapter.md` (third in implementation order)
- `briefs/Q-006-hide-edit-landing-page.md` / `briefs/Q-015-hide-admin-mcp-tools.md` / `briefs/Q-004-post-on-account-internalOnly.md` (MCP hygiene; land Q-004 with Q-014)

Mapping: `mappings/designarena-image-models.md`,
`mappings/content-gen-graph.md` (Remotion vs HyperFrames/Comfy),
`mappings/eval-output-summary.md` (Q-002 parser, not a live router).

The loop may keep refining until `stop_after` (see `STATE.md`;
extended 2026-09-11 for the architecture/SDLC track).

## Architecture / SDLC track

Kevin asked to research nanoservice splits vs Hermes / Oh My Pi.
Read `sdlc/THESIS.md` then `sdlc/COMPARISON.md`. Product READY items
are unchanged. HTTP-per-tool is discarded (A-006).
