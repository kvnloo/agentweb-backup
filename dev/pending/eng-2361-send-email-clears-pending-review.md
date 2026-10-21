## ENG-2361: manual email send clears Pending Review (2026-10-21)

Sending a lead's email draft from the lead panel now moves a `pending_review` lead to `contacted` (or the list's first active status) via `statusAfterReviewedSend` in `utils/leadSchema.ts`.
