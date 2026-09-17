# RFC-H-JEV — `jev_decide` Emma tool

**Status:** ready · **Issue:** [#6](https://github.com/kvnloo/agentweb/issues/6) · **Epic:** [#4](https://github.com/kvnloo/agentweb/issues/4)

## Problem

Emma spends full LLM turns on small routing decisions. Hermes uses JEV for typed, budgeted semantic decisions. Emma has no equivalent.

## Proposal

Add **`jev_decide`** via new side-effect module — not `emma/tools.ts` (upstream #2832).

- `backend/src/emma/jevTools.ts` — register tool + executor
- `backend/src/emma/jevAdapter.ts` — OpenJev / TypeSafe wire (optional split)

### Env

| Var | Values | Default |
|-----|--------|---------|
| `JEV_BACKEND` | `openjev`, `typesafe`, `off` | `off` |
| `JEV_TIMEOUT_MS` | integer | `2500` |

Fail-open on timeout/error — never block the agent loop.

## Acceptance (Phase 1)

- [x] #10 — `jevTools.ts` in Emma tool catalog
- [x] #11 — JSON fixture tests
- [x] Document env vars (`backend/.env.example`)

## Sub-issues

#10, #11, #12 (Phase 1b parked)
