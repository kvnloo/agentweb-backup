## ENG-2644: public iShare stop compares the conversable token (2026-10-26)

`POST /api/agent-mode/ishare/:id/stop` (`stopGenerationPublic`) required a `conversable` query token but
never compared it with the session's interactive-share token, and skipped the expiry check. Anyone who had
the id of an interactively shared chat could therefore cancel the owner's run. It now checks the token first (wrong or missing: 401), then answers 410 for an expired or switched-off share. The
route deliberately writes nothing on expiry: stop only cancels a run, and deactivating from a stale read could
overwrite a share the owner just re-created (the other `/ishare` routes still switch expired shares off). The portal already sends the token
(`useAgentModeChat.tsx`), so no portal change is needed. `getInteractiveShareExpiresAt` moved unchanged to
`utils/interactiveShare.ts` so other public routes can share it.
