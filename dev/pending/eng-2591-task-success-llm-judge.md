## ENG-2591: LLM task-success judge (2026-10-21)

**Why.** The deterministic `agent-task-success` grader trusts the plan's own step checkmarks. Against blind AI labels on the 40 test work-plan cases, it measured kappa 0.20.

A rule-based v2 was tried and dropped. It added three rules: fail on an unrecovered write failure, fail on steps bulk-closed without work, and fail when the final reply admits failure.
- **Dev, tuned on 17 cases:** kappa 0.87.
- **Test, scored once:** kappa 0.28.

The misses are semantic, so step statuses and the call ledger can't capture them: a deliverable that failed while the reply claimed success, a report built on the wrong account's data, an ignored "don't call X", and intake answers the user never gave.

**What.**
- `services/taskSuccessJudge.ts` is an LLM judge for golden criterion `task_success`.
  - It uses the human labelling rubric, adds a deliverable/constraint/fabrication checklist before the verdict, and outputs `pass|fail|na` as JSON.
  - It reads the session as a trace (`agentRunTrace.ts`) rendered to compact text.
  - It defaults to Claude Sonnet 5 and refuses Gemini/OpenAI judges, since the agent runs on Gemini.
  - Errors carry no verdict.
  - The registry entry is `agent-task-success-judge`, versioned by the prompt's hash.
- `runValidation.ts`: `loadTraceForGrading` and `taskSuccessJudgeGrader`, so `runGraderValidation.ts agent-task-success-judge` scores it against human labels.
- `scripts/runTaskSuccessJudgeTrial.ts` is a read-only trial.
  - It calls OpenRouter directly with no spend rows, under a `--max-usd` cap.
  - Stdout carries case ids and verdicts only.

**Next.**
1. Run the trial on dev and test, about $2 for all 80 work-plan cases, and compare against the blind AI labels.
2. If kappa ≥ 0.6, a person labels 30 test cases for the real validation.
