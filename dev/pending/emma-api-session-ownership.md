## Emma API: session_id in a request body is not authorisation (2026-10-22)

`/api/emma/*` routes are thin delegates to agentModeService (see the ENG-973 note on the same
shape). The tool implementations behind them take a `sessionId` and load the session by id with no
idea who is asking, because the in-process agent path only ever hands them the session it is
running. The routes passed `req.body.session_id` straight through, so `authenticateToken` proved
who the caller was but nothing checked that the session was theirs.

**Rule now applied in the route layer** (`sessionAccessAllowed` in `routes/emmaApi.ts`): the same
predicate agent mode uses to open or run a chat (`agentModeController.getSession` /
`generateResponse`): the session owner, or `req.user.isAdmin`. Delegate (support) tokens need no
special case: `middleware/auth.ts` resolves `req.user` to the target account and minted delegate
tokens carry `isAdmin: false` (`services/delegateAccessToken.ts`), so a delegate passes on exactly
the target's chats. A missing session and a foreign one both answer 404. Only the session record is
read (`getChatSessionRecord`), never the message table.

- Mandatory session (400 when absent): `POST/PUT /work-plans`, `PATCH /work-plans/status`,
  `POST /send-for-review`.
- Optional session, checked when present: `generate-image`, `generate-video` (write a transcript
  message and tool cost to the session), `create-html`, `create-html-template` (tool cost),
  `task-from-template`, `task-from-prompt`, `image-task-from-prompt` (read the session transcript
  for prior task results).
- Left as is: routes where the id is only stamped as metadata on the caller's own records or logged
  (knowledge-base routes, `describe-media`, `save-file`, `create-html-from-template`), is unused by
  the service (`social-posts`, `update-html-file`, `repair-blog`), or already had an owner check
  (`meta-ads/marketing-api`). The `X-AgentWeb-Session` header on the blog routes can only add a
  publish re-check, never remove one.

No first-party code calls the work-plan or review routes over HTTP: the agent's `create_work_plan`
/ `modify_work_plan` / `set_work_plan_status` / `send_for_review` tools call `emma/impl/workPlans.ts`
in process, and no MCP self-call sends a body `session_id`. When adding a route that takes a session
id, gate it with the helper. Do not rely on the service to scope the session.
