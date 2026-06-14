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

| Metric | Baseline | After proof slice | After dispatch seam |
|---|---|---|---|
| `agentModeService.ts` (the monolith) | 24,205 lines | 24,213 lines (+8) | **23,895 lines (−318)** |
| `agentModeController.ts` | 6,511 lines | 6,511 lines | 6,511 lines |
| Lines in `services/agentMode/core/` (prod) | 0 | 279 | **801** (types 95 + termination 128 + agentStep 56 + toolDispatch 522) |
| Characterization harness | ❌ none | ✅ 203-line harness + 3 scenarios (4 tests) | ✅ + 4 dispatch scenarios (8 char tests total) |
| Core unit tests | 0 | 10 (termination) | **19** (termination 10 + toolDispatch 9) |
| **Seams migrated** | **0 / 6** | **1 / 6** (termination) | **2 / 6** (termination + tool dispatch) |

> The proof slice was +8 (the inline termination ladder moved to a tested pure module,
> the loop applies counter deltas explicitly). The **dispatch seam is the first
> NET-NEGATIVE slice: the monolith drops 318 lines** as the per-iteration validate →
> dispatch → process-results block (~372 lines inline) moves into a single tested
> boundary, `core/toolDispatch.ts → executePreparedTools`. That module owns Phase 1
> (gateway policy + arg validation/repair + preflight failures), Phase 2 (parallel-vs-
> sequential decision + gateway execution + `toolResultError` classification), and
> Phase 3 (screenshot S3 upload, minimal-result extraction, CRM socket emit, large-
> response S3 offload, DynamoDB truncation, tool-message + counter-delta appending).
> Every entangled side-effect is **injected as a port** (gateway executor, leaf tool
> executor, S3 uploaders, socket emitter, telemetry recorder, classifiers, the
> instance helpers `extractMinimalToolResult`/`formatToolError`, CRM payload builder),
> so core drags none of the 24k-line monolith. **Left inline (separate concerns / loop
> state):** the counter-flush DB calls (`incrementCalledFunctions`/`incrementFailedFunctions`,
> which consume the returned delta maps), the `onProgress` events, and the anti-loop
> detection (consecutive + sliding-window signature) — those are loop-state, not
> dispatch, and belong to a later seam.

### Agentic-reliability parity checklist (vs Claude Code / Codex)
- ✅ Structured tool-error taxonomy (`toolErrorClassifier`)
- ✅ Per-run repeated-failure circuit breaker (gateway)
- ✅ Post-run outcome verdicts (ok / degraded / failed)
- ✅ Eval-from-failures seeded (`loops/scripts/exportEvalCases.ts`)
- ✅ Learning-loop gate built (Slack-reaction ApprovalGate stamps `shippedAt`) — ⚠️ OFF by default
- ✅ Fragility fixes shipped (worker-crash lock, concurrent-claim race, O(n²) trim, SSE zombie, alert flood) — #1882
- 🟡 Small composable core loop — **IN PROGRESS** (characterization harness + core scaffold + termination + tool-dispatch boundary extracted)
- ❌ Typed tool registry at the boundary (gateway exists; not yet a typed-registry abstraction — `core/types.ts` defines the target interface)
- ❌ Idempotent / resumable runs keyed by run id (runId threaded for telemetry only)
- ❌ Streaming as an explicit contract

## Seam roadmap (strangler order, from the 2026-06-14 loop map)

1. **Seam 1 — termination decision** → `core/termination.ts`. ✅ **DONE** (proof slice).
2. Seam 2 — tool-call parse/normalization → extract `JSON.parse(arguments)` + shaping into core (pure).
   ⏳ NOT YET as a standalone seam — `JSON.parse(arguments)` currently lives inside the dispatch
   boundary's Phase 1 (`core/toolDispatch.ts`). A future PR can lift the pure parse/normalization
   step out of `executePreparedTools` into its own module if it earns the split.
3. **Seam 3 — tool dispatch boundary** → `core/toolDispatch.ts → executePreparedTools`. ✅ **DONE**
   (this slice). NOTE: branched/PR'd under the title "Seam 2: tool-dispatch boundary" — the *roadmap*
   numbers it #3; it is the dispatch seam regardless of the PR label. Not yet behind a typed
   `ToolRegistry.execute` abstraction — dispatch goes through injected gateway/executor ports today;
   converging on the `ToolRegistry` interface (`core/types.ts`) is follow-up.
4. Seam 4 — anti-loop detection → pluggable pure policy (consecutive + sliding-window signature).
   (Still inline in the loop after this slice — it is loop-state, not dispatch.)
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

## Reliability snapshot — the trend line (telemetry-only, 2026-06-14)

The recorder writes per-run agent-mode events to `Dev-AW-LoopEvents`
(`loopId='agent-mode'`), and the 17:30 UTC analysis loop clusters failures for
fix dispatch — but neither leaves a **daily reliability trend line**. The
snapshot job adds one without touching the chat path.

- **Job**: `backend/src/cron/agentReliabilitySnapshotCron.ts`
  (`runAgentReliabilitySnapshot`), wired in `server.ts` to run daily at **17:45
  UTC** (between the agent-mode learning loop at 17:30 and generic attribution at
  18:00). Gated by **`AGENT_RELIABILITY_SNAPSHOT_ENABLED=true`** (off by default,
  consistent with the other loop crons). Best-effort/swallowed — never crashes
  boot. Pure metric math lives in `backend/src/cron/agentReliabilitySnapshot.ts`.
- **Computes** (24h + 7d rolling, both persisted): `tool_success_rate`
  (`agent_tool_succeeded / agent_tool_invoked`), `degraded_run_rate` /
  `failed_run_rate` (over `agent_run_verdict` events), `run_count`, median/p90
  iterations (per-run max `agent_decision.iteration`), and the top 5
  `toolName×errorClass` failure clusters.
- **Where it writes**: back into the SAME `Dev-AW-LoopEvents` table under a
  distinct **`loopId='agent-reliability-daily'`**, SK=`<date>#<window>` so the
  write is an idempotent overwrite (re-running a day replaces, never duplicates).
  No new table / no `create-tables` / `ensureCriticalTables` change needed — the
  existing PK+SK schema + `query` path cover it.
- **How to read the trend**:
  - CLI: `npx ts-node backend/scripts/show-reliability-trend.ts`
    (`--days=30`, `--window=7d`, `--json`).
  - Admin endpoint: `GET /api/admin/loops/reliability-trend?days=14&window=24h`
    (auth + isAdmin; returns snapshots oldest-first).
- **Behavior-preserving**: summarizes events the recorder already wrote; reads
  from / writes to telemetry only. Zero change to chat outputs, tool selection,
  prompts, or model defaults.
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
- **2026-06-14 · Tool-dispatch seam** — extracted the per-iteration validate → dispatch → process-
  results block (~372 lines) out of `generateMarketingResponse` into `core/toolDispatch.ts`
  (`executePreparedTools`, 522 lines), entangled side-effects injected as ports; the loop delegates
  and consumes the returned counter-delta maps. Added 4 dispatch-specific characterization scenarios
  (parallel multi-tool / sequential wait_seconds / tool-error mid-batch / large-result S3 offload),
  captured against the UNCHANGED monolith FIRST, then byte-identical AFTER. **Behavior-preserving
  proof: all 8 characterization snapshots identical before/after.** `npx tsc` exit 0; characterization
  8/8, core termination 10/10, toolDispatch unit 9/9; agentModeService regression (generateImage /
  crmTools / socialTools / backupModel / extractMinimalToolResult / fathomToolAccess) 189/189.
  Monolith 24,213 → **23,895 (−318 net — first net-negative slice)**; core prod 279 → 801. Seams 2/6.
  Left inline: counter-flush DB calls, onProgress events, anti-loop detection (loop-state, later seams).
  **Outcome: GREEN.** Branch `swarm/agentmode-core-dispatch` → PR vs `harsha/swarm` (not merged).
