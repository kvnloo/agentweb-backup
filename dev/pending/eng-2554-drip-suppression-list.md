## ENG-2554: Drip do-not-email suppression matcher (2026-10-19)

Pure `backend/src/services/dripSuppressionList.ts`: exact + `@domain` entries, fail-closed on invalid recipients, ordered dedupe partition. Not wired into a send path yet (ENG-2167 Phase 1 compliance slice).
