# ENG-2060 — verifier work-plan lifecycle fixture + Okareo scenario

Covers the MCP lifecycle added by ENG-2057:
`list_predefined_work_plans` -> `emma_launch_work_plan` -> `emma_get_session` (poll) ->
`emma_answer_work_plan_input` -> `emma_get_session` (read-back).

## Fixture (staging, verifier-owned, non-customer)

- Account: the post-merge verifier's own staging user (never a customer org).
- Private predefined work plan titled exactly `[verifier-fixture] MCP work-plan lifecycle`,
  owned by that user, with one step whose structured input request has a single text field
  `verifier_token`. No other tools/skills on the step, so provider cost is one bounded turn.
- Probe: `backend/src/verification/workPlanLifecycleProbe.ts` (`runWorkPlanLifecycleProbe`).
  It refuses (fail closed) when:
  - the fixture title lacks the `[verifier-fixture]` prefix;
  - there is not exactly one fixture plan, or it is owned by another account;
  - the session is not owned by the verifier account (checked before any launch);
  - the awaiting input fields differ from the fixture contract (never answers a foreign request);
  - polling exceeds `maxPolls` (default 20) — bounds provider spend.
- Output is a `ProbeEvidence` JSON (steps, planId, requestId, polls) to attach to ENG-2057.

## Okareo scenario (runs once ENG-1095's connector credential clears)

Scenario name: `emma-mcp-workplan-lifecycle-v1`, target STAGING.

| # | User turn to the MCP-connected agent | Expected tool sequence | Check |
|---|---|---|---|
| 1 | "Start the verifier lifecycle plan in session S" | list_predefined_work_plans, emma_launch_work_plan | correct plan id, no other plan launched |
| 2 | "Is it waiting on me?" | emma_get_session | reports pendingWorkPlanInput, does not call emma_send_message |
| 3 | "verifier_token is eng-2060-deterministic" | emma_answer_work_plan_input | values keyed by field id; not a plain message |
| 4 | "Done?" | emma_get_session | no awaiting input remains |

Baseline: `emma-no_hallucinated_capabilities_v2` pass count must not regress against the
ENG-502 baseline; the tool-sequence checks are new and must be 4/4.

## Not yet done (outside this PR)

- Creating the fixture plan/user row in staging is an operational write performed by the
  verifier with its own staging credentials; it is not a schema or customer-data change.
- Executing the Okareo scenario requires ENG-1095 (Okareo credential, nondelegable).
