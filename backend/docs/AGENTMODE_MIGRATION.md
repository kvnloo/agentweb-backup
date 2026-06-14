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

- **2026-06-14 · Reliability: search/read_tool_response S3 retrieve cluster** — fixed the #1
  fixable internal tool-failure cluster from production telemetry (`Dev-AW-LoopEvents`,
  `agent_tool_failed`, last 7d): `search_tool_response` (32) + `read_tool_response` (29) = **61**
  combined failures. **Real failure modes found (NOT S3 flakiness — zero transient S3 errors in the
  window):**
  - **35 — numeric/boolean args emitted as strings** (`char_offset: "0"`, `char_length: "8000"`,
    `match_offset: "20"`). The gateway type-validator (`validateAndRepairToolArgs`) hard-rejected them
    with `schema_reject` before execution. *Fix:* added a **scalar-coercion repair phase** in the
    gateway (`coerceScalarForSchema`) that coerces a string that cleanly round-trips to the schema's
    `number`/`integer`/`boolean` type — mirroring the existing `json_stringify` repair. General across
    ALL tools, not just these two.
  - **18 — "tool is not available, install the required skill first"** (`model_uninstalled_tool`).
    Root cause: `FOUNDATION_TOOLS` is a mutable set loaded from the DB `foundation_tools` setting which
    *replaces* the defaults; a saved list omitting the two overflow-retrieve tools made them
    unavailable — so the model couldn't resolve the `[Full response stored at S3 key: …]` pointer it
    was just handed. *Fix:* added both tools to `MANDATORY_FOUNDATION_TOOLS` (force-merged on every DB
    load/update) — they are overflow infrastructure, never a skill.
  - **9 — missing required `s3_key` / `query`** (`schema_reject`). The validator already returns a
    model-actionable retry message; these convert to a retry naturally — no code change.
  - **Retrieve-side hardening (defense-in-depth; 0 occurrences in window but requested):**
    `getS3ObjectAsString` now retries transient S3 errors (throttling/timeouts/5xx/conn-reset) with
    bounded exponential backoff, and throws terminal errors (NoSuchKey/NoSuchBucket/AccessDenied)
    immediately. Both handlers now treat benign misses (empty object, key gone/expired, zero matches,
    offset past end) as **`success: true` + model-actionable guidance** instead of `success:false` —
    important because dispatch counts ANY `success:false` as `agent_tool_failed`. Real unexpected
    errors after retries still return `success:false`.
  - **Expected impact:** ~53 of the 61 sampled failures convert to success-or-graceful (35 coercion +
    18 availability); the remaining ~9 missing-arg cases become clean retries. Target: these two tools'
    failure rate → ~0.
  - **Success path behavior-preserving:** already-correct numeric args, present keys, and non-empty
    responses are byte-identical to before (verified by tests). **Deferred to STORE side (collision
    guard — another agent owns `agentModeService.ts` ~2825–3189):** the in-region availability-check
    message and the S3 store path were not touched; the mandatory-tools fix neutralizes the store-side
    availability gap at the config layer instead.
  - `npx tsc` exit 0. New/updated tests: gateway coercion (7), s3Utils retry/backoff (5),
    handler graceful-miss (13) — all green; related suites (toolFailureType, mcpToolContent,
    trimToolContext, performDataAnalysis, full gateway+s3Utils) green. **Outcome: GREEN.**
    Branch `swarm/agentmode-toolresponse-fix` → PR vs `harsha/swarm` (not merged).
