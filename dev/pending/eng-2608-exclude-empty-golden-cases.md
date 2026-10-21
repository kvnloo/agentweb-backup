## ENG-2608: exclude empty golden cases (2026-10-21)

**Why.** 20 of the 80 `work_plan_session` golden cases were predefined work plans that were opened and never used: no messages, never updated after creation, every step pending. They could not be labelled or graded. The seeder took any session with a work plan.

**What.**
- `GoldenCase.excluded` `{ reason, by, at }`: an admin takes a case out of the set without deleting it.
  - `listCases` skips excluded cases unless `includeExcluded` is set; the seeder sets it so it never re-adds one.
  - An excluded case doesn't count toward the work-plan target.
- Admin API:
  - `PUT /api/admin/eval/golden-cases/:caseId/exclusion` with `{ reason }` excludes a case; `DELETE` on the same path restores it.
  - `GET /` takes `includeExcluded=true`.
- The work-plan seed source skips sessions whose `updatedAt` is not after `createdAt`. This separates the 20 from the 60 used sessions exactly.

**After deploy.** Exclude the 20 cases with reason `empty_session`.
