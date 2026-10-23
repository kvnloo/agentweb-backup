## ENG-2645: share-link responses are an allowlist of what the viewer's page reads (2026-10-23)

`GET /api/agent-mode/share/:id` (unauthenticated) and `GET /api/agent-mode/ishare/:id?conversable=…` are the
same handler (`agentModeController.getSharedConversation`). Before this change both returned the session record
nearly as stored: row 0 is the stored system prompt (~100 KB), and `filterMessagesForClient` only drops `role:'tool'`
rows and admin-tainted turns, so assistant rows kept `reasoning`, `reasoning_details`, `usage`, `refusal`. The
read-only response also carried the owner's whole skills catalog (`getSkillsForDisplay` = everything the owner's plan
allows, private/org skills, "Other Skills", and "Admin Tools" for admin owners), `supportNote`, `slackThread`, and
`interactiveShareMetadata` — whose `token` is the conversable credential, so a read-only viewer could drive Emma on
the owner's account whenever an interactive share was active.

**Rule now:** `utils/shareViewerSerializers.ts` builds both responses from explicit allowlists.
- Read-only (`ShareConversation.tsx`): `sessionId, title, messages, workPlan, pendingApprovalDeck`; only user and
  assistant rows, each `{ role, content, metadata: timestamp|toolCalls|citations|attachments|pendingApprovalDeckId }`.
  The catalog and the owner record are not read at all.
- Conversable (`AgentMode.tsx` via `useAgentModeSessions`, plus the landing-page `/api/status` poll):
  `sessionId, title, messages, createdAt, updatedAt, workPlan, llmModel, hasActiveProgress, supportNote, slackThread,
  skills, pendingWorkPlanInput, pendingApprovalDeck`. Rows keep `role, content, llm, modelCorrection, messageIndex,
  clientId` and the metadata keys the chat reads. System rows the chat does not render are sent as
  `{ role:'system', content:'', messageIndex, metadata: timestamp|kind|isErrorMessage }` placeholders, NOT dropped:
  AgentMode counts rows (`messages.length > 1`, the empty-chat state, last-message checks) and the landing-page poll
  reads `isErrorMessage` on any row. Successful `upload_image`/`upload_video` system rows are rendered, so they are
  kept whole. `skills` = this session's installed skills only, never `__admin_tools__` (an ishare turn cannot run
  admin tools anyway); the generate response's `skills` is narrowed the same way.
- `PUT /ishare/:id/message/:i/feedback` answers `{ success, message: { metadata: { feedback } } }` (all the portal
  reads) instead of the raw stored row — the index is raw, so the old response could return a row the viewer's chat
  hides.

When a share page starts reading a new field, add it to the allowlist in `shareViewerSerializers.ts`; the
`agentModeController.shareViewerRedaction.test.ts` suite pins both the absences and the rendered fields. The stored
session is never modified — generation still reads the system prompt server-side. The owner's own
`GET /session/:id` is unchanged. `getConversableSession` is not routed (the ishare GET is `getSharedConversation`)
but now shapes its rows the same way.
