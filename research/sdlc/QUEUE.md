# Architecture / SDLC queue

Source of truth: `research/sdlc/queue.json`. **Not** the product queue.
Product implementation order is still Q-001 → Q-014 → Q-003.
`coding_unlocked: false`.

Thesis: `THESIS.md`. Comparison: `COMPARISON.md`.

## Ranked (architecture track)

| Rank | ID | Score | Status | Title |
|---|---|---|---|---|
| 1 | A-001 | 32 | **ready** | Modular monolith thesis (this folder) |
| 2 | A-002 | 28 | **ready** | CI import boundary for `loops/core` |
| 3 | A-005 | 25 | keep | File-size ratchet vs stale 24k scorecard |
| — | A-004 | 19 | park | Split `emma/tools.ts` after #2832 |
| — | A-003 | 16 | park | Wire `executeAgentStep` (Harsha / Q-010) |
| — | A-006 | 6 | **discard** | HTTP nanoservice per tool |

## First SDLC coding (only after product unlock, and not instead of Q-014)

1. **A-002** — prove `loops/core` cannot import the host.
2. **A-005** — fail PRs that grow `agentModeService.ts` without a core extraction.

Never A-006. Never a Kubernetes slice of Emma as a first architecture PR.
