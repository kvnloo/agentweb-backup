## ENG-3004: Preserve uncertainty in incomplete tracking diagnoses (2026-11-14)

- Pixel/CAPI failure is ruled out only by a positively healthy, complete account-scoped sweep; token/fetch errors, unclassifiable/idle observations, missing counters and empty sweeps remain unchecked. Matching positive alerts retain precedence.
- Destination evidence no longer defaults missing unverifiable counts to zero; mixed normal/insufficient-history campaign reports no longer dismiss demand/variance uncertainty.
- Verification: mocked diagnosis and discrimination suites (44 tests), backend typecheck and production build passed on Atem. No live-account mutation or persistence change. Rollback: revert this change; post-deploy admin read should confirm inaccessible tracking remains unchecked.
