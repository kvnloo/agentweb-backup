# Jev integration opportunities in the AgentWeb backend

**Status:** design/research only; no runtime changes proposed in this document  
**Scope:** `backend/src`, especially Emma agent-mode, Slack, scheduled runs, enrichment, and intake  
**Jev target:** TypeSafe System One (`jev-latest` / `jev-1.13.0`), using bounded `Choice`, `Score`, and `Noul` judgments

## Executive decision

Start with **HTML report classification** in shadow mode. It is already an isolated three-way classification, has a deterministic fallback (`research`), is not on the agent tool loop, and has an existing Gemini result that can serve as the control label. It gives a clean first production measurement of Jev latency, availability, probability calibration, disagreement, and unit cost without allowing Jev to block work or mutate data.

Do **not** put Jev in front of every tool call, let it veto tool names, or make it an agent-loop overlord. The useful seams are existing bounded decisions whose option set is known before inference.

The repository already contains a suitable transport foundation:

- `backend/src/emma/jevAdapter.ts:1-9, 95-120, 295-361` — TypeSafe/OpenJev REST adapter, 2.5 s default timeout, typed response validation, fail-open behavior.
- `backend/src/emma/jevTools.ts:15-71` — internal `jev_decide` Emma tool supporting `choice`, `noul`, and `score`.

For backend hot paths, call the adapter from a domain-specific wrapper rather than asking the primary agent to decide whether to call `jev_decide`. That removes an unnecessary full agent turn and keeps each decision's labels, thresholds, fallback, and telemetry server-owned.

## Ranking method

Rank combines: frequency potential, size of the displaced LLM/vendor work, boundedness of the output, consequence of a wrong answer, ease of offline/shadow evaluation, and whether the current code already has a safe fallback. Exact production call counts and TypeSafe pricing were not present in the repository, so dollar claims below are **per-call formulas and relative savings**, not invented monthly totals.

For every candidate, measure:

- `jev_latency_ms`, current-decision latency, timeout/error rate
- selected label and full probability vector
- top-1 confidence and top-1/top-2 margin
- agreement with current decision and adjudicated accuracy on disagreements
- current provider input/output tokens and cost versus Jev billed cost
- downstream avoided cost, where the decision can skip a larger workflow

## Ranked opportunities

### 1. Report type classification — **Phase 1 recommendation**

**Pointer:** `backend/src/services/reportClassificationService.ts:4-17, 19-55`, `classifyReport()`  
**Current decision:** one Gemini Flash Lite call classifies a filename plus 500-character excerpt into `creative | performance | research`; 10 s outer timeout; malformed/error fallback is `research`.  
**Jev primitive:** `Choice` with exactly those three labels and their existing definitions.

**Why this ranks first**

- Perfectly bounded, single-label output; no rationale or generation is required.
- Existing function is already isolated and metered as `report_classification`.
- A wrong label affects presentation/routing semantics, not external publication, auth, billing, or data mutation.
- Existing fallback is explicit and safe enough to preserve unchanged.
- The incumbent result can run in parallel during shadowing, making evaluation straightforward.

**Expected savings**

- Latency: replace a provider call allowed to consume up to **10 s** with a Jev call bounded by the adapter's current **2.5 s** timeout; expected latency should be measured, not assumed. At the cited ~256 ms Jev median, the classification component would commonly fall by seconds, but that external benchmark is not an AgentWeb SLO.
- Cost: remove the Gemini classification request (prompt + up to 5 completion tokens) once enforced. Net per-call savings = current `report_classification` LLM charge minus Jev charge. The absolute dollar value requires real usage and the TypeSafe rate card.

**Confidence gate and fallback**

- Enforce only when `top_probability >= 0.90` **and** `(top_probability - second_probability) >= 0.25`.
- Otherwise call the incumbent classifier; on Jev timeout, invalid response, disabled backend, or missing key, use incumbent unchanged.
- If both fail, preserve today's `research` fallback.
- Never let a shadow result alter the returned category.

**Shadow design**

Run Jev and the current classifier concurrently for 7–14 days or at least 1,000 decisions. Log only bounded/redacted inputs already sent to the incumbent. Report confusion matrix, coverage at candidate thresholds, p50/p95 latency, failure rate, cost per 1,000, and manually adjudicated disagreements. Promotion criterion: no material loss on an adjudicated stratified sample, >=95% agreement on high-confidence covered cases, and lower p95/cost than incumbent. Tune thresholds from data rather than weakening them to hit coverage.

---

### 2. Explicit stop/pause detection for autocomplete continuation

**Pointer:** `backend/src/controllers/agentModeController.ts:1501-1580`, `userExplicitlyRequestedStop()`; consumer at `:1706-1722`.  
**Current decision:** Gemini Flash Lite answers yes/no, allows up to 500 completion tokens because short limits were consumed by hidden reasoning, and has an 8 s timeout.  
**Jev primitive:** `Noul`: probability that the user's latest real message explicitly asks Emma to stop, pause, wait, or do no more work now.

**Expected savings**

- Latency: replace an up-to-8 s reasoning-model judge in an already-latency-sensitive continuation path; Jev's probability is the complete output, eliminating hidden-reasoning truncation observed in comments at `:1544-1551`.
- Cost: remove up to 500 completion-token allowance plus prompt tokens per stalled continuation; net savings are current `stop_request_judge` charge minus one Noul charge.

**Confidence gate and fallback**

This is asymmetric: false negatives disobey a stop request; false positives suppress useful continuation.

- `P(stop) >= 0.90`: suppress continuation.
- `P(stop) <= 0.10`: continue.
- Middle band, Jev unavailable, or malformed result: run the incumbent Gemini judge.
- Preserve current final fail-safe (`false`, do not suppress) only if both systems fail; emit a metric because it may miss a real stop.

**Why not Phase 1:** low call volume is likely (only stalled autocomplete plans), and the semantic consequence is user-control sensitive. It is an excellent second integration after calibration.

---

### 3. Scheduled-run “defers to user” detection

**Pointer:** `backend/src/controllers/agentModeController.ts:3566-3618`, `scheduledTurnDefersToUser()`; result use at `:3679-3691`.  
**Current decision:** regex fast path, then Gemini Flash Lite yes/no with an 8 s timeout to detect whether an unattended run stopped for human confirmation instead of delivering.  
**Jev primitive:** `Noul`: probability the assistant response defers completion pending human input.

**Expected savings**

- Latency: on regex misses, replace an up-to-8 s extra model call after the main run.
- Cost: remove the fallback judge's prompt/completion charge for each otherwise-successful scheduled turn reaching this check.
- Reliability: typed probability avoids parsing “yes/no” and enables an explicit ambiguity band.

**Confidence gate and fallback**

- Keep the regex fast path first at zero cost.
- `P(defers) >= 0.95`: classify as confirmation halt.
- `P(defers) <= 0.10`: classify as delivery.
- Ambiguous/unavailable: incumbent Gemini judge.
- Preserve the existing publish-withhold exemption before Jev; Jev must not reinterpret explicit authorization logic.

**Risk:** a false negative can mark incomplete unattended work as complete. Require shadow evaluation on real scheduled outputs before enforcement.

---

### 4. Same-name LinkedIn candidate disambiguation during enrichment

**Pointer:** `backend/src/services/enrichmentV3RealDeps.ts:937-951, 1045-1121`, `pickCandidateByContextLLM()`.  
**Current decision:** an extraction LLM chooses one candidate index or `-1`, self-rates context strength/confidence, and quotes evidence; four guards prevent wrong-person attachment.  
**Jev primitive:** `Choice` over `candidate_0 ... candidate_n, none`; optionally batch a `Score` for context specificity (`weak`, `moderate`, `specific`).

**Expected savings**

- Latency/cost: replace a JSON-generating extraction call inside per-lead enrichment. This can compound across large lead lists, making it the strongest batch-volume opportunity if telemetry confirms the branch is common.
- Output reliability: index is constrained to supplied options; `none` is first class rather than a magic `-1`.

**Confidence gate and fallback**

- Accept a candidate only when top probability >=0.95, margin >=0.30, and context-specificity score is at the top level.
- Otherwise return `null` (refuse enrichment) or use the incumbent LLM during rollout. Never fall back to candidate zero on uncertainty.
- Keep deterministic name matching and usable-public-identifier checks before/after Jev.

**Important limitation:** Jev Choice does not supply the incumbent's verbatim evidence quote. In Phase A, retain the current evidence guard as the authority and use Jev only in shadow. Enforcement should require an offline result showing probabilities are at least as safe as the quote-backed guard, or add a deterministic overlap check from context to candidate profile. Wrong-person enrichment is a data-integrity error, so this is not a first deployment.

---

### 5. Product issue / feature request deduplication

**Pointer:** `backend/src/services/dedupService.ts:4-27, 46-70, 78-130`, `findDuplicate()`; callers at `backend/src/services/intakeService.ts:259-268, 380-387`.  
**Current decision:** configured LLM chooses a 1-based candidate index or null among up to 30 candidates, returns confidence/reason, and merges only at confidence >=75. Timeout is 12 s.  
**Jev primitive:** `Choice` over stable candidate refs plus `new_item`.

**Expected savings**

- Latency: replace an up-to-12 s structured-output judge on each non-exact-match filing.
- Cost: remove up to 120 completion tokens plus a prompt containing as many as 30 candidate summaries.
- Correctness ergonomics: Jev cannot hallucinate an out-of-range index because labels are the candidate refs supplied by the caller.

**Confidence gate and fallback**

- Merge only if selected option is not `new_item`, probability >=0.95, and margin over runner-up/new >=0.30.
- Any ambiguity, error, or missing candidate label => create a new canonical (today's safe behavior), not merge.
- During initial enforcement, optionally send Jev disagreements to the incumbent judge; do not let incumbent low confidence override `new_item`.

**Risk:** false merges are expensive and hard to notice. Evaluate separately for bugs and feature requests; their candidate distributions differ.

---

### 6. Scheduled-run pre-check (“likely nothing actionable”)

**Pointer:** `backend/src/services/agentModeService.ts:17040-17116`, `evaluateScheduledRunPreCheck()`; invocation and force-proceed guard at `backend/src/controllers/agentModeController.ts:6296-6325`; fold logic in `backend/src/utils/scheduledRunPreCheck.ts`.  
**Current decision:** Gemini Flash Lite returns `proceed | skip`, confidence, and reason from schedule instructions and recent no-output history. It is fail-open and periodically bypassed after a skip streak.  
**Jev primitive:** batched questions: `Choice(proceed, skip)` plus `Score(insufficient, suggestive, unambiguous)` or a single `Noul` for “near-certain nothing actionable.”

**Expected savings**

- Direct: replace the up-to-10 s / 150-token pre-check classifier.
- Downstream: a correct high-confidence skip avoids an entire multi-step scheduled agent run, which can be orders of magnitude more expensive than the classifier. This gives the highest theoretical dollar leverage in the list.

**Confidence gate and fallback**

- Initially shadow only; compare against incumbent and actual outcome of the run that still proceeds.
- Enforce skip only at `P(nothing_actionable) >= 0.98`, top-tier evidence score, and the existing deterministic prerequisites/skip-streak rules.
- Any uncertainty/error => proceed.
- Keep forced real runs after the existing skip cap. Jev may advise this bounded pre-check but must never become a general tool/action veto.

**Why ranked sixth despite leverage:** ground truth is delayed and asymmetric, and a false skip silently drops customer value. The decision is appropriate for Jev but requires more evidence than low-impact classifiers.

---

### 7. Meeting action-item routing and priority

**Pointer:** `backend/src/services/meetingIntakeService.ts:1-12, 126-249, 299-403`, `classifyActionItem()` and `processActionItems()`; tool entry at `backend/src/emma/meetingActionRouter.ts:15-40, 69-74`.  
**Current decision:** regex/keyword scores route each item to `eng-task | delivery-task | feature-request | ignore` and set `High | Medium | Low`; comments explicitly say no LLM is used for speed.  
**Jev primitive:** batched `Choice` for route plus `Score` for priority for every action item in one request.

**Expected savings**

There is no LLM cost to remove today. Value would be improved semantic recall over brittle keywords while preserving low latency, not direct savings. Batch all items from one meeting to avoid N network calls.

**Confidence gate and fallback**

- Shadow Jev against current labels and human destination outcomes.
- On enforcement, use Jev only above route probability >=0.90 and margin >=0.25; otherwise keep `classifyActionItem()`.
- Never create tasks from a Jev `ignore`/actionable disagreement without observing it first, because routing has external-write effects.

**Why low-ranked:** existing route implementations are placeholders/TODOs at `meetingIntakeService.ts:90-113`, so optimizing classification before the destination integrations are real has limited immediate ROI.

---

### 8. Initial-session model tier recommendation (advisory only)

**Pointer:** model policy resolution in `backend/src/controllers/agentModeController.ts:319-425`; Slack session hot path at `backend/src/routes/slack.ts:280-332, 914-923`; primary call at `backend/src/services/agentModeService.ts:2827-2868, 4202-4210`.  
**Current decision:** session/user choice and server policy select a concrete model; Slack uses the session model or default.  
**Jev primitive:** `Choice(cheap_fast, standard, capable)` from the first request, attachment metadata, and task class.

**Expected savings**

Potentially large if repeated simple Slack/Emma tasks can use a cheaper model; potentially harmful if complex work is under-routed. Savings formula is the selected-model price delta times actual prompt/completion tokens, minus one Jev call. Latency may improve when a cheaper model is selected but gains are workload/provider dependent.

**Confidence gate and fallback**

- Recommendation only at first: log suggested tier, do not override explicit user selection, admin entitlements, usage policy, scheduled backup policy, or provider fallback.
- Later, permit only **down-routing** from the system default for high-confidence `cheap_fast` classifications (>=0.98 and large margin) with automatic escalation on tool-loop failure or low-quality verifier outcome.
- Never use this as a per-turn tool-name gate and never re-route every tool step. At most decide once at session start or at an explicit phase boundary.

**Why last:** broad blast radius, confounded quality measurement, and existing model-policy invariants make this much harder to prove than replacing already-bounded judges.

## Non-opportunities / explicit boundaries

1. **Per-turn tool allow/deny or tool-name vetoes:** rejected. AgentWeb already has deterministic authorization, publish consent, read/write classification, required-call ledgers, and tool dispatch invariants. A semantic model must not sit above them.
2. **Auth, billing, subscription, spend caps, consent, idempotency, capacity, or account-connected gates:** keep deterministic. Probability is not an authorization primitive.
3. **Freeform generation:** session titles, summaries, suggested replies, diagnoses, email/ad copy, and corrective rewrites do not fit Choice/Score/Noul because the output itself is text.
4. **Finalize-guard claim extraction:** `agentModeService.ts:17177-17230` returns an unbounded list of quoted claims. Jev can score known candidate classes, but it cannot replace extraction without first deterministically enumerating claims; leave this for a separate design.
5. **Agent-chosen `jev_decide` on every turn:** the existing internal tool is useful for explicit bounded subproblems, but relying on the main model to invoke it does not save the model-selection/agent turn. Backend-owned wrappers are the ROI path.

## Shared production design

### Domain wrapper

Build one small server-owned decision service over `runJevDecide()` with a decision ID, versioned question schema, timeout, threshold policy, and fallback callback. Each use case owns its labels and thresholds. Do not expose raw provider output to control flow without validation already supplied by `jevAdapter.ts:178-220`.

### Modes

- `off`: no call; current behavior.
- `shadow`: call Jev asynchronously or concurrently, record result, never alter behavior.
- `assist`: accept only high-confidence Jev; ambiguity invokes incumbent.
- `enforce`: Jev is primary, with documented safe fallback.

Configure mode per decision, not globally. `TYPESAFE_API_KEY` must come from the existing secrets/config path, never source or logs.

### Caching

Cache by `decision_id + schema_version + normalized state hash + model` only for immutable inputs. Good candidates: report classification and intake dedup within a filing. Avoid cross-run caching for schedule pre-checks or user stop intent because recency is part of the state. Cache only successful validated answers; do not cache transport failures.

### Telemetry and privacy

Record decision ID/version, backend/model, latency, answer probabilities, mode, whether fallback ran, incumbent result, and final applied result. Do not log raw Slack text, lead PII, report bodies, or candidate profiles beyond existing retention policy. Attribute Jev cost to the same `usageContext.feature` as the displaced call so before/after reporting remains comparable.

### Failure semantics

The adapter already returns typed skipped results for disabled, missing credentials, timeout, HTTP error, invalid response, and validation error. Every call site still needs a domain fallback:

- classification: incumbent, then today's default;
- user-control checks: incumbent, then current conservative behavior;
- dedup/enrichment: refuse merge/match;
- scheduled pre-check: proceed;
- routing: current deterministic classifier.

A successful HTTP call is not sufficient: only validated answers above the decision-specific gate may affect behavior.

## Concrete Phase 1 plan: report classification shadow

1. Define `report_type_v1` as Choice(`creative`, `performance`, `research`) using the category text already in `reportClassificationService.ts:10-17`.
2. In `classifyReport()`, invoke Jev concurrently with the current Gemini classifier when mode is `shadow`; preserve the Gemini return value byte-for-byte.
3. Use the same filename and 500-character excerpt; do not expand the privacy surface.
4. Emit one structured comparison event with Jev probabilities, Jev latency/status, incumbent label/latency/tokens/cost, and disagreement. No report content in telemetry.
5. Run for 7–14 days or >=1,000 decisions. Sample disagreements across all three incumbent labels and confidence bands for human adjudication.
6. Produce a threshold table showing coverage, adjudicated precision, p50/p95, availability, and cost per 1,000 at 0.80/0.90/0.95 confidence and 0.15/0.25/0.35 margin.
7. Promote to `assist` only if the high-confidence slice meets the stated accuracy criteria. In assist mode, low confidence/unavailable calls use Gemini; if Gemini fails, preserve `research`.
8. Roll back by setting this decision's mode to `off`; no schema or stored-data migration is needed.

## Bottom line

The best near-term use of Jev is to replace **small incumbent LLM judges**, not to supervise the agent. Report classification is the safest proving ground. Stop/deferral detection follows once probabilities are calibrated. Enrichment and dedup offer stronger batch savings but require conservative refusal behavior. Scheduled pre-check has the largest possible downstream savings and the largest silent-failure cost, so it should be validated against completed real runs before it can skip any work.