## ENG-2976: Pure playbook provenance + usage ledger reducer (2026-11-12)

Shadow-only `reducePlaybookLedger` in `backend/src/services/marketingPlaybookLedger.ts`: per (org, playbook, version) usage, campaigns, outcomes, provenance with `missing_provenance` flag, cross-org events rejected. Not wired into any live path; no persistence.
