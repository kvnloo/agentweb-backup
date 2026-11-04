## ENG-2793: Pure tenant-scoped playbook promotion/staleness policy (2026-11-03)

Adds `backend/src/services/marketingPlaybookPolicy.ts`, a pure shadow-only policy (ENG-1970.3) deciding promote_campaign / promote_tenant / hold / stale / expire per org+action kind. Not wired into any write path; no persistence.
