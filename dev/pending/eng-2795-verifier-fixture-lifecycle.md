## ENG-2795: Publish-gate verifier fixture lifecycle and dry-run cleanup (2026-11-03)

- Added `docs/publish-gate-verifier-fixture.md` (owning org, isolation, draft-branch setup, cleanup, cost ceiling) linking the ENG-2794 harness.
- Added `backend/src/services/publishGateVerifierCleanup.ts`: pure dry-run planner that selects only `publish-gate-verifier`-tagged pages in the verifier org; never deletes.
