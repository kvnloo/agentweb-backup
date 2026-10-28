## ENG-270: Fathom onboarding admin discard/rollback actions (2026-10-07)

- `POST /api/admin/fathom-onboarding/users/:userId/ingestions/:recordingId/discard` marks a needs_review item discarded and flags its draft account `fathomDraftStatus=discarded` (stays `isActive:false`); reviewed items return 409 until rolled back.
- `.../rollback` returns a reviewed item to needs_review and deletes only the account/org memories recorded on that ledger entry.
- Both idempotent. No schema/table change: operates on the existing `fathomOnboardingIngestions` user attribute.
