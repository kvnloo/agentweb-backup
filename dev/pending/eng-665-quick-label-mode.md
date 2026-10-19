## ENG-665: quick labelling mode for one-off validation sets (2026-10-19)

Validating `agent-task-success` needs a person to set one criterion (`task_success`) on the 50 test-split work-plan cases, once. The labelling page showed all seven agent criteria per case and needed a click per criterion plus Save, which made a one-criterion pass feel like a full review.

Changes (partner portal, `EvalLabelling.tsx`): a Task type filter next to Split, and a Quick mode select (one criterion). In quick mode only that criterion is shown; keys 1 / 2 / 3 (or the buttons) save Pass / Fail / N/A for the open case, keep its other labels, and open the next case in the filtered list that lacks the criterion. AI-labelled cases stay blinded as before (the save carries only the human label and clears the AI note). Also: `seedGoldenCases.ts` now defaults the AWS region to `us-west-2` (an ops run without `AWS_REGION` failed with a missing-region error), and two behaviour-criteria help-text assertions in `EvalLabelling.test.tsx` that had gone stale were updated.

How to label: Eval labelling → Agent sessions → Split `test`, Task type `work_plan_session`, Quick mode `task success only`; read the conversation, press 1 / 2 / 3.
