## ENG-2507: Pure scheduled-post request validator (2026-10-16)

- Added `backend/src/services/scheduledPosts/validateScheduledPostRequest.ts`: pure ok/error validator (platform x/instagram/linkedin, tz-qualified future publishAt within 90 days via injected clock, per-platform content caps, http(s) media URLs, Instagram requires media). No persistence, no tool registration; storage/firing remain gated on ENG-2501.
