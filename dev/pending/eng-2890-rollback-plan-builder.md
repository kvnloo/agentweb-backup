## ENG-2890: pure rollback-plan builder for reversible campaign actions (2026-11-10)

- `backend/src/services/marketingActionRollback.ts`: `buildRollbackPlan(action, snapshot)` returns the exact inverse (status/budget/bid) for owned ad/adset/campaign edits, else `{reversible:false}`. Fail closed on missing/mismatched snapshot. Shadow only, not wired into any execution path.
