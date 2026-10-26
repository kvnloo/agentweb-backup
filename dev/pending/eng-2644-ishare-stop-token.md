## ENG-2644: public iShare stop compares the conversable token (2026-10-26)

`POST /api/agent-mode/ishare/:id/stop` (`stopGenerationPublic`) required a `conversable` query token but
never compared it with the session's interactive-share token, and skipped the expiry check. Anyone who had
the id of an interactively shared chat could therefore cancel the owner's run. It now applies the same
checks as the other `/ishare` routes (`getProgressPublic`, `uploadIShareAttachment`): an expired share is
switched off and answers 410, and a wrong token answers 401. The portal already sends the token
(`useAgentModeChat.tsx`), so no portal change is needed. `getInteractiveShareExpiresAt` moved unchanged to
`utils/interactiveShare.ts` so other public routes can share it.
