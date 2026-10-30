## ENG-2746: Scheduled-post command service (create/list/edit/cancel) (2026-10-29)

Pure owner-scoped command layer in `backend/src/services/scheduledPosts/scheduledPostCommands.ts` over an injected repository port. No table, scheduler, or tool registration; persistence and plan gating remain on ENG-2501.
