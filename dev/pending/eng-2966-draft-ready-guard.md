## ENG-2966: Require persisted draft before review status (2026-11-13)

- A lead could be put in `pending_review` (the AI-draft review queue, ENG-2361) with no draft
  on it, so the Pending Review filter listed leads with nothing to approve.
- New pure helpers in `backend/src/utils/leadSchema.ts`: `hasPersistedDraftForChannel(lead, channel?)`
  (email = `emailDraft.subject` + `textContent`/`htmlContent`; linkedin = `messageDraft.content`;
  no channel = either) and `missingReviewDraftError(status, lead)`.
- `update_lead_status` (`emma/impl/leads.ts`) checks the lead as it would be after the write
  (stored drafts + drafts passed in the same call) and returns a tool error telling the agent to
  create the draft first; nothing is written.
- `PUT/PATCH /api/crm/lists/:listId/leads/:leadId` returns 400 for a move INTO `pending_review`
  without a draft (including a request that clears the only draft). Writes on a lead already in
  `pending_review`, and every other status, are unchanged.
- No other server path sets `pending_review` on a lead (bulk-contact-status only sets `contactStatus`).
- No backfill: existing draftless `pending_review` leads are left as-is (ENG-2966 item 2+).
