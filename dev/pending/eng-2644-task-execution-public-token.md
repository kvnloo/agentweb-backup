## ENG-2644: public task-execution status requires the conversable token for an interactive share (2026-10-26)

`GET /api/tasks/:id/executions/:executionId/public?sessionId=` (`getTaskExecutionPublic`) served a task execution
(status, message, result file URLs and their tokens) to anyone holding the session id of an interactively shared
chat: it only checked `interactiveShareMetadata.isActive` (the expiry check was commented out) and never the
share's token. It now needs `&conversable=<token>` for an interactive share, with the same expiry/token checks as
the `/ishare` routes (shared `getInteractiveShareExpiresAt`): expired answers 410 and switches the share off, a
missing or wrong token answers 401. A live read-only share (`shareMetadata.isShared`) is unchanged and still
needs no credential (portal `ShareConversation.tsx`). If the read-only share has expired but an interactive
share is live, the token is required instead of the previous blanket 410. The portal's `TaskExecutionStatus`
now sends the token (portal PR).
