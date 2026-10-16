## ENG-2508: Pure scheduled-post due selector + lifecycle transitions (2026-10-16)

- Added `backend/src/services/scheduledPosts/scheduledPostLifecycle.ts`: `selectDuePosts(records, now)` and `transition(record, action)` (edit/cancel/idempotent markFired) with typed results. In-memory only; storage/firing gated on ENG-2501.
