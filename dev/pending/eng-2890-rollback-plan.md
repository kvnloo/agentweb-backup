## ENG-2890: pure rollback-plan builder for reversible campaign actions, shadow-only (2026-11-10)

`backend/src/services/marketingActionRollback.ts`: given a proposed mutation + pre-change snapshot, returns the exact inverse (status/budget/bid) or reversible:false (fail closed). Not wired into any execution path.
