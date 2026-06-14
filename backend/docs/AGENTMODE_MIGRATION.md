# AgentMode Migration — monolith → agentic core (strangler)

> Canonical, in-repo objective tracker for migrating AgentMode (Emma chat) from one
> ~24k-line imperative "chat + tools" loop into a small, composable **agentic core**
> (Claude-Code / OpenAI-agent-loop / Hermes / OpenClaw shaped), **behavior-preserving**,
> with that grade of reliability. Update the scorecard + push log on every push.

## The rework

Approach (chosen 2026-06-14): **strangler extraction** — build a clean core boundary,
wrap current behavior in characterization tests, then extract one seam at a time until
the monolith is gone. **Proof-slice first**: prove the approach end-to-end on one path
before scaling it. Branch: `harsha/swarm`.

**Process:** push → observe effects → push → observe. Make fast decisions when there
are no issues. The scorecard below IS the objective record.

## Target architecture

A single legible core step (`core/agentStep.ts → executeAgentStep`):

```
model call → parse tool calls → dispatch via typed registry → append results → decide termination
```

with the bulk of logic in **pure, individually-tested modules** the loop composes:

- `core/types.ts` — `RunContext`, `StepInput`/`StepResult`, `LoopCounters`,
  `TerminationReason`, `ToolRegistry` (typed boundary, dependency-free).
- `core/termination.ts` — PURE termination-decision ladder (extracted, seam #1).
- `core/agentStep.ts` — one-iteration seam (skeleton; monolith delegates termination today).

The characterization harness (`src/__tests__/agentMode/characterization/`) pins the
observable contract — tool-call sequence, final content, `responseMessages` shape,
LLM-turns consumed — with `callLLM` + `executeTool` stubbed and **no network**. It is
the behavior-preserving proof reused by every seam.

## Objective scorecard

Baseline = `origin/harsha/swarm` at commit 47e3594c (post reliability-v1 #1882).

| Metric | Baseline | After proof slice |
|---|---|---|
| `agentModeService.ts` (the monolith) | 24,205 lines | 24,213 lines (+8) |
| `agentModeController.ts` | 6,511 lines | 6,511 lines |
| Lines in `services/agentMode/core/` (prod) | 0 | 279 (types 95 + termination 128 + agentStep 56) |
| Characterization harness | ❌ none | ✅ 203-line harness + 3 scenarios (4 tests) |
| Core unit tests | 0 | 10 (termination) |
| **Seams migrated** | **0 / 6** | **1 / 6** (termination) |

> The monolith is +8 net this slice: the inline branch ladder moved to a tested pure
> module, but the loop now applies counter deltas explicitly (a few lines). Honest, flat.
> The decision *logic* + its full branch coverage now live in a 128-line tested module
> instead of inline. Subsequent seams (parse, dispatch, anti-loop) trend the monolith down.

### Agentic-reliability parity checklist (vs Claude Code / Codex)
- ✅ Structured tool-error taxonomy (`toolErrorClassifier`)
- ✅ Per-run repeated-failure circuit breaker (gateway)
- ✅ Post-run outcome verdicts (ok / degraded / failed)
- ✅ Eval-from-failures seeded (`loops/scripts/exportEvalCases.ts`)
- ✅ Learning-loop gate built (Slack-reaction ApprovalGate stamps `shippedAt`) — ⚠️ OFF by default
- ✅ Fragility fixes shipped (worker-crash lock, concurrent-claim race, O(n²) trim, SSE zombie, alert flood) — #1882
- 🟡 Small composable core loop — **STARTED** (characterization harness + core scaffold + seam #1)
- ❌ Typed tool registry at the boundary (gateway exists; not yet a typed-registry abstraction — `core/types.ts` defines the target interface)
- ❌ Idempotent / resumable runs keyed by run id (runId threaded for telemetry only)
- ❌ Streaming as an explicit contract

## Seam roadmap (strangler order, from the 2026-06-14 loop map)

1. **Seam 1 — termination decision** → `core/termination.ts`. ✅ **DONE** (this slice).
2. Seam 2 — tool-call parse/normalization → extract `JSON.parse(arguments)` + shaping into core (pure).
3. Seam 3 — tool dispatch boundary → `executePreparedTools` behind `ToolRegistry`.
4. Seam 4 — anti-loop detection → pluggable pure policy (consecutive + sliding-window signature).
5. Seam 5 — message trimming → wire existing `trimToolMessagesForContext` through core.
6. Seam 6 — model backup selection → already inside `callLLM` (no-op; document the boundary).

Each seam: characterization snapshots pass UNCHANGED + the extracted module has its own
unit tests + PR ledger shows net-negative-or-flat monolith lines + one fewer responsibility
inline. One seam per PR.

## Push log

- **2026-06-14 · Foundation** — 7 reliability PRs consolidated (#1882) merged to `harsha/swarm`;
  full suite green. Hardening, NOT re-architecture. Monolith 24,205 lines.
- **2026-06-14 · Proof slice** — characterization harness (3 scenarios: happy / tool-error→retry /
  no-tool) passing against the UNCHANGED monolith → proves the harness captures real behavior.
  `core/` scaffold (types + termination + agentStep seam). First REAL extraction: termination
  decision moved into `core/termination.ts`, loop delegates via `computeTermination`.
  **Behavior-preserving proof: characterization snapshots byte-identical before/after.**
  `npx tsc` exit 0. agentModeService suite 1495/1495 pass; core termination 10/10; characterization
  4/4. Monolith 24,205 → 24,213 (+8 net). Seams 1/6. **Outcome: GREEN — strangler approach validated
  end-to-end on one path.** Branch `swarm/agentmode-core-proofslice` → PR vs `harsha/swarm` (not merged).

- **2026-06-14 · Reliability/observability — tool-error classifier fix** — production telemetry
  showed the error taxonomy was blind: a 7-day sweep of `Dev-AW-LoopEvents` `agent_tool_failed`
  events (283 failures) had **85.5% recorded as the generic `Error` fallback**, and even
  re-classifying the raw messages with the then-current patterns still left **63.3% as `Error`**
  (dev.md target: <20%). Extended `classFromMessage` in `utils/toolErrorClassifier.ts` with patterns
  drawn from the real messages and added three new classes:
  - `tool_unavailable` (~41) — `Tool "X" is not available. You must install the required skill…`
    (model called an uninstalled skill — the single largest missed cluster).
  - `upstream_rejected` (~28) — LinkedIn business-rule refusals (`Cannot resend yet`, `Should delay
    new invitation`, `not a 1st-degree connection`): the provider accepted the call and deliberately
    refused the action.
  - `empty_result` (~9) — `No search results found`, `Unable to retrieve a Summarizer summary.`,
    `No analysis results received from Gemini` (call succeeded, no data).
  Also widened `invalid_args` to catch schema-validation rejections (`arguments failed schema
  validation`, `has the wrong type`, `Missing required argument/variable`, `… (is|are) required`,
  ~45 newly caught), `auth` to catch permission/missing-connection failures, `timeout` for
  `operation was aborted`, and `not_found` for `does not exist`. `utils/toolFailureType.ts` updated
  to route the new classes (`tool_unavailable`→`model_uninstalled_tool`, `upstream_rejected` +
  `empty_result`→`by_design`).
  **Result on the same 283-failure set: fallback `Error` 63.3% → 10.2%** (29 residual are
  idiosyncratic one-offs — `Unknown error`, `success=false`, file-hash mismatch — with no
  clusterable class). Now-visible clusters: invalid_args 28.3%, tool_unavailable 14.5%,
  rate_limit 13.8%, auth 9.9%, upstream_rejected 9.9%, timeout 4.9%, not_found 4.6%,
  empty_result 3.2%. **Chat behavior unchanged — telemetry labels only.** `npx tsc` exit 0;
  toolErrorClassifier 17/17, toolFailureType + runRecorder suites green (62/62 across the three).
  Branch `swarm/agentmode-error-classifier` → PR vs `harsha/swarm` (not merged).
