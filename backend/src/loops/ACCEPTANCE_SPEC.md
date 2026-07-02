# Closed-Loop Framework — End-to-End Acceptance Spec

**Status: IMMUTABLE. Written by Harsha 2026-05-25. Claude is NOT permitted to modify this file after writing it. The framework is "done" when running the smoke test produces the full chain described below, end-to-end, without human intervention during the run.**

This is the contract. If the apparatus doesn't satisfy what's below, the apparatus is broken — fix it and re-run. Iterate until it passes.

> **Amendment 2026-07-02 (founder decision): the complaint / low-CSAT friction variant was REMOVED.**
> The only real-data feeder of a "complaint" was a fuzzy LLM satisfaction score
> (`complaintChannel: 'llm_judge'`, score ≤ 3 — which even includes NEUTRAL). There is no wired
> real-complaint source (support ticket / email / NPS), so the `complaint-received` rule only ever
> fired from unreliable LLM sentiment against a `> 0 over 7d` threshold — pure noise that opened
> spurious cloud-dev tasks. The `complaint_received` event, the `complaint-received` rule, and the
> `complaint_review` mutation surface are gone. The hard-signal friction variants — **failure**
> (`eval_failed`) and **timeout** (`eval_abandoned`) — remain the contract. The low-satisfaction
> score is kept only as a passive aggregate stat (`lowSatisfactionCount` / `lowSatSamples`), not as
> a rule trigger. The strikethrough annotations below mark what was removed.

---

## The three required personas

A smoke-test run replays scripted event streams for these three personas through the sensor layer. Each persona has an expected "marking" the framework must apply, surfaced in the smoke-test report.

### 1. Early-Dipper — *"a persona that bounces early gets marked somewhere"*

- Lands on `/ai-eval`. Sees the page. Does not submit the form. Leaves.
- Event stream: `landed` (single event, no follow-on).
- **Expected marking:** the smoke report classifies this persona as `bounced_early` with the dimension `last_stage_reached = landed`. The aggregate metric `form_submit_rate` is depressed by this persona's contribution. The policy layer fires a rule of class `capture-broken` (or equivalent low-funnel-conversion rule) when enough early-dippers accumulate.

### 2. Completer — *"a persona that finishes completely gets marked as positive"*

- Lands, fills the form, watches the eval run, sees the report, clicks signup, finishes.
- Event stream: `landed` → `form_submitted` → `eval_started` → `eval_completed` → `report_viewed` → `signup_clicked` → `signed_up`.
- **Expected marking:** the smoke report classifies this persona as `completed` with the dimension `funnel_completion = 1.0`. No rule fires solely on this persona's data — they're the healthy baseline.

### 3. Failure / Timeout — *"if a person complains or something (or if the wait times are too long and so people get distracted) that would get marked"*

- Either: the eval fails (LLM-side failure caught by the agent-mode session and surfaced via `metadata.isErrorMessage`), OR the user abandons during the polling phase because the wait exceeds patience (>120 seconds without `eval_completed`). ~~OR a downstream complaint signal arrives (support ticket, email, low CSAT — any explicit negative).~~ *(complaint variant REMOVED 2026-07-02 — see amendment above; no real complaint source was ever wired, only an LLM satisfaction score.)*
- Event stream variants:
  - **Failure variant:** `landed` → `form_submitted` → `eval_started` → `eval_failed` (with `errorMessage` dimension carrying the LLM failure text).
  - **Timeout variant:** `landed` → `form_submitted` → `eval_started` → (>120s elapsed) → `eval_abandoned` (with `elapsed_ms` dimension).
  - ~~**Complaint variant:** `landed` → `form_submitted` → `eval_completed` → `complaint_received` (with `complaint_text` dimension).~~ *(REMOVED 2026-07-02.)*
- **Expected marking:** the smoke report classifies the persona as `friction_signal` with the dimension `friction_type ∈ {eval_failed, eval_timeout}`. The policy layer fires a rule of class `eval-failing` (failure variant) or `wait-too-long` (timeout variant). The triggering error text / elapsed time MUST appear in the resulting mutation proposal so the human reviewer sees what broke. *(The `complaint` friction type and the `complaint-received` rule were removed 2026-07-02.)*

---

## The end-to-end chain

After running the smoke test, the apparatus MUST execute the following sequence with no human intervention during the run:

1. **Persona replay** — feed 3+ event streams per persona type (so 9+ streams total) into the sensor.
2. **Sensor returns events** — the `EventSource` implementation normalizes and returns the events as a unified stream.
3. **Policy bubbles up suggested fixes** — *"the apparatus needs to immediately start bubbling up suggested fixes"*. The policy layer evaluates the events against the rule DSL, fires at least one rule per friction-signal class, and produces `MutationProposal` records.
4. **Generator + Critic produce concrete fix text** — the Bedrock-backed Generator turns each proposal into a concrete change (new copy variant, code-change spec, Emma question, etc.). The Critic filters by rubric.
5. **Cloud-dev gets triggered** — *"submitting those fixes to cloud dev which triggers the cloud dev"*. Each surviving proposal produces a real Notion task in the Sprint Tasks DB tagged for cloud-dev pickup. The Notion task contains: the rule that fired, the triggering data (with error text / timeout inline; complaint text removed 2026-07-02), the proposed code change spec, and the human-review context.
6. **Cloud-dev builds the fix** — cloud-dev picks up the Notion task and produces a PR. (This step uses the existing cloud-dev pipeline; the framework only triggers it.)
7. **Slack DM lands for Harsha's review** — *"once it is built and ready for review it should send me a slack dm that I review"*. The approval-gate layer posts a real DM to Harsha's Slack with: the smoke-test summary, the personas processed, the rules that fired, links to the Notion tasks + PRs, and ✅/❌/🛑 reactions for the decision.

The smoke test PASSES when step 7 completes successfully and Harsha can confirm the DM is in his Slack DMs.

---

## What counts as "real"

- **Notion task creation in step 5:** real. The task must exist in the Sprint Tasks DB after the smoke test runs and be visible at notion.so. Stubs are not acceptable here.
- **Slack DM in step 7:** real. The DM must land in Harsha's actual Slack. Stubs are not acceptable here.
- **Bedrock calls in step 4:** real. (Cost capped at $30 per the plan.) Stubs acceptable ONLY for unit-level tests of the Generator/Critic wiring, not for the end-to-end smoke run.
- **Sensor + Learning Store backing data:** in-memory or local DynamoDB stubs are acceptable for the hermetic smoke run, as long as the data flow through the layers is real. Production deploy of these is out of scope for this acceptance.
- **Cloud-dev pipeline in step 6:** the framework triggers cloud-dev; whether cloud-dev itself runs in this session depends on cloud-dev's own scheduler. If the Notion task is created with the right tags and structure, the framework's responsibility is satisfied; the actual PR opening is cloud-dev's responsibility.

---

## Iteration rule

If running the smoke test produces a failure at any step, Claude MUST:

1. Identify which step failed.
2. Identify which layer was responsible.
3. Fix the responsible layer.
4. Re-run the smoke test from the beginning.
5. Repeat until all 7 steps pass.

**Do not edit this spec file.** If something in the spec seems wrong or impossible, post a Notion comment with the specific question and wait for Harsha's response. Do not silently relax the contract.

---

## Out of scope for this acceptance

- Production deploy of the framework to AWS Elastic Beanstalk.
- The full byte-identical behavior-equivalence test for the existing onboarding loop (separate Phase 2 task).
- 95% test coverage on every file. Pragmatic coverage on the smoke path is sufficient for this acceptance.
- A working `/ai-eval` lander in production with real LinkedIn traffic. This acceptance proves the framework. The production lander integration is Phase 3 of the original plan.
- Cloud-dev itself running in this session (it runs on its own scheduler). The framework's contract is "create a Notion task that cloud-dev will pick up."

---

## Definition of pass

The smoke test passes when, in a single invocation:

- All three personas' event streams are replayed.
- The smoke report shows each persona's expected marking.
- The policy layer fires at least one rule per friction-signal class.
- At least one Notion task is created in the Sprint Tasks DB containing a usable spec for cloud-dev.
- One Slack DM lands in Harsha's actual Slack DMs containing the run summary + the proposed fixes + reaction prompts.
- Total runtime under 10 minutes (excluding Bedrock call latency, which can be slow).

If all of the above is true, Harsha confirms by reacting to the DM. The framework is then considered to pass this acceptance.
