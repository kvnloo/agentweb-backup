## ENG-2651: caller-named session ids must be the caller's before an iShare link is minted (2026-10-23)

`POST /api/human-eval/candidates` passed a caller-supplied `sessionId` straight to
`humanEvalService.createCandidate`, whose `resolveChatUrl` calls
`chatbotDb.createOrReuseInteractiveShare(sessionId)` and returns the link (with its conversable token)
as `candidate.chatUrl`. Any signed-in user who knew another account's chat id got a link that opens
and chats in that chat; reviewer feedback was later written into it (`addFeedbackToSession`). The
route now accepts only a session the caller owns, or any session for an admin (the
`agentModeController.getSession` / `routes/emmaApi.ts` rule; delegate tokens resolve `req.user` to the
target), and answers anything else 404 before the artifact claim or any candidate exists.

Same class, also fixed: `POST /api/landing-pages/v0/generate` stored `originating_session_id` unchecked
as the page's `originatingSessionId`, which `durableLandingService.postToSession` writes the
completion/failure message into and `enqueueLandingPageHumanEval` mints an iShare link for. A session
the caller may not open is now dropped (not refused): the MCP `generate_landing_page` tool sends
`context.sessionId`, which for external MCP clients is the MCP transport session id, not a chat.

Audit of every other `createOrReuseInteractiveShare` / `createCandidate` caller (none reachable with a
foreign id handed back to the caller):
- `agentModeController.createConversableShare`: owner-only check already present.
- `routes/admin.ts ensureIshareLinkForReview`: admin router (`isAdmin`).
- `emma/tools.ts enqueue_human_eval`, `enqueueLeadEnrichmentEval`, `mediaVideo` image/video auto-eval,
  `humanEvalActionService` rerun: `sessionId` comes from the running agent's context; the routes that
  start a run gate the session (generateResponse; emmaApi `generate-image` / `generate-video` via
  `sessionAccessAllowed`, #3702).
- `emailService` scheduled-result / digest / session-notification emails: session ids come from the
  owner's schedule run results or the running agent's context; recipients are owner-configured.
- `conversation/sessionResponder.ts`, `routes/slack.ts`, `revisionService.ts`, `utils/agentModeAlerts.ts`:
  server-created or server-bound sessions; links go to the Slack thread owner or internal on-call only.
- `resultEndpointController` (`POST /r/:name/trigger`): mints for the anonymous session it just created.
- `routes/resultEndpoints.ts GET /review/:sessionId` (unauthenticated): returns the iShare URL of any
  result-endpoint session to whoever holds its session id. Different class (session id as a
  capability, by design for reviewer links); not changed here, listed for follow-up.
- `emmaEmailService.processInboundEmail`: `[ref:<id>]` continues any session — ENG-2652.
