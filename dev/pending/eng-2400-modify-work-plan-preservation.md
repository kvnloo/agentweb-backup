## ENG-2400: modify_work_plan preserves work-plan data on partial/failed modifies (2026-10-11)

- Omitting `description` on an existing step no longer wipes the stored description (same contract as userInstructions/skillIds).
- Steps are deep-copied before mutation, so a failed modify never mutates the read session plan.
- A non-sequential stepCount result (e.g. removing step 2 of 3 without renumbering) now returns an actionable "renumber the remaining steps" message instead of the generic "Failed to modify work plan". The store already rejects it before writing.
- Test: `backend/src/__tests__/modifyWorkPlan.preservation.test.ts`.
