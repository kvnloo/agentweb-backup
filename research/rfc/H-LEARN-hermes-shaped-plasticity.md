# RFC-H-LEARN — Self-learning like Hermes

**Status:** ready · **Issue:** [#8](https://github.com/kvnloo/agentweb/issues/8) · **Epic:** [#4](https://github.com/kvnloo/agentweb/issues/4)

## Anchor

Extend existing ads-scoped learning (`adsScopedLearning.ts`, ENG-1968 tests) — not greenfield.

## Phases

| Phase | Issue | Deliverable |
|-------|-------|-------------|
| 0 | #16 | ReliabilityEvent schema |
| 1 | #17 | Append-only sink at tool boundary (fail-open) |
| 2 | #18 | Lesson promotion with human review (parked) |
| 3 | — | Loops closed-loop after A-002 (#22) |

## Non-goals

Rewrite `agentModeService.ts`, nanoservices (Q-013 rejected)
