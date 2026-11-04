## ENG-2797: pure execution-authorization gate + rollback-inverse builder (2026-11-03)

Shadow-only `backend/src/services/marketingActionExecutionGate.ts`: `authorizeExecution` (standing auth or exact-payload-hash approval, reversible classes only) and `buildRollback` (exact inverse from prior provider state, null when irreversible). Not wired into execution; no provider calls or persistence.
