## ENG-2547: Pure SalesForge handoff eligibility for drip air-cover leads (2026-10-19)

Added `backend/src/services/dripSalesforgeHandoff.ts`: pure decision (suppressed > already_pushed > not_opted_in > invalid_email > not_warm > outside_window). No API/persistence wiring yet.
