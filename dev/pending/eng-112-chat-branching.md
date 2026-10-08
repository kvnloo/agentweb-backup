## ENG-112: Chat branching ("Branch from here") with no new persisted field (2026-10-08)

**What it does.** `POST /api/agent-mode/session/:sessionId/branch {messageIndex, llmModel?, idempotencyKey?}`
creates an ordinary new session whose history is the source's rows `[0..k]`, so the user can continue on a
different model and compare. Behind the AW-Settings flag `chat_branching_enabled` (default OFF; only the exact
value `true` enables it; an unreadable row is OFF). Logic: `backend/src/services/agentMode/chatBranching.ts`
(pure, injected deps, same shape as `modelComparison.ts`); wiring: `controllers/chatBranchController.ts`.
`GET /model-options` carries an additive `chatBranchingEnabled` hint for the portal.

**Why no schema change.** The branch is built with `createChatSession` from an allowlist (llmModel,
associatedSkills, portalType `agent`, pageIdentifier only if `agent-mode` or `skill-*`, selectedStartupId,
sessionType forced `regular`, the *request's* delegateInfo) and its rows go through `addMessagesToSession`.
Provenance is one free-form key, `metadata.branchOrigin`, on row 0 (the stored system prompt). Row 0 is never
sent to the model (`buildMarketingContext` slices at index 1), model comparison reads only user/assistant rows
and the portal renders no bubble for role `system`. A separate provenance *row* was rejected: a second
`system` row would land at index 1, i.e. in the model's context, and break every "row 0 is the system prompt"
assumption.

**Hazards found while proving it (each has a test).**
- `addMessagesToSession` runs `incrementTokenUsage`; copying `usage` would bill the branch for turns it never ran.
  `usage`, `metadata.feedback`, `clientId` and the stale `messageIndex` are stripped; everything else is copied.
- `addMessagesToMessagesTable` logs and swallows batch items still unprocessed after 3 retries (silent partial
  copy). The service re-reads the new session consistently and fails (the half-built branch stays hidden) unless
  rows are dense `0..n-1`, `messageCount` matches and row 0 carries the provenance.
- Raw `messageIndex` values are sparse in the client view (tool rows and tool_calls-only assistants are hidden).
  The index is resolved against the raw rows, must be visible to the viewer and must be a non-error assistant
  reply; contiguous following tool rows are copied with it.
- ENG-2163: admin-taint is computed from tool-result rows in the turn. For an admin branching inside a tainted
  turn the whole turn is copied so the customer-facing filter still redacts the narration and the prompt.
- `messages[0]` is assumed to be the system prompt in `buildMarketingContext` (`startIdx = 1`).
- A prefix must leave 10 messages of headroom under `MAX_MESSAGE_SIZE_PER_SESSION`.
- `tryClaimSessionGeneration` is an in-process Set (as is `withKeyedMutex`): single-instance assumption, same as
  /generate and compare/select. Idempotency: in-process in-flight/replay map plus the `AGENT_RUN_STORE` `idem#`
  lane createSession uses (so with the store off, only same-instance retries are deduped).

**Review hardening (follow-up commit).**
- Continuation triggers: getSession re-fires a billed `scheduleAutoMediaContinuation` for an owner view whose tail is
  an unresolved media deferral < 1h old (`hasUnresolvedMediaDeferral`). Copied rows therefore lose
  `metadata.mediaBudgetDeferred` and the `deferred` flag of `media_generation_time_budget` entries in `toolCalls`.
- Hidden until verified: the session is BORN archived (`createChatSession` initialState `archived: true`, the
  existing field, excluded by every list), filled, verified, then revealed by `ChatbotDB.unarchiveSession`, which
  REMOVES the `archived` attribute (no new stored shape; every reader treats absent as live) and is conditional on
  the row existing (a vanished id is not upserted; it is logged as vanished, not retried, and answers 500). Reveal
  retries 3x. The new id is logged at creation, so a death mid-copy leaves a hidden, greppable session, never an
  empty visible one.
- Idempotency: scope is `JSON.stringify([...])` (injective). A concurrent request with the same key waits for the
  first and answers 200 with the same branch (replay); replay also checks source session + message index. A
  cross-instance in-flight claim (run store) is still 409 DUPLICATE_SUBMIT.
- Idempotency scope = `branch|source|messageIndex|llmModel|key`. Owner-only (a delegated admin arrives as the
  target). `(branch)` suffix is not stacked. A target with no preceding user row is a 400 `no_user_message`.
- Per-user cap: AW-Settings `chat_branching_max_per_hour` (cached ~60s, last-known fallback; absent/invalid = 30,
  `0` = unlimited), in-memory sliding window per instance, 429 `TOO_MANY_BRANCHES`; counted once the request holds
  the source lock and refunded unless a session was created.
- Share/conversable views drop `metadata.branchOrigin` (`filterMessagesForClient({omitBranchOrigin})`).

**Residual risks.** Analytics that count sessions/user messages (satisfaction scoring, summaries, asset cache,
`engagement.emma_session` CRM event) see a branch as a new session with copied history; assets generated in the
prefix appear in the branch's Images/Videos lists. Only `regular` agent-portal chats are branchable (others carry
session-level state a branch deliberately does not copy).

**Archived sessions and operators.** Admin-only readers (the admin recent-sessions list, the reliability snapshot
cron) can see archived sessions, including a born-archived branch mid-copy and an archived orphan left by a process
death. This is pre-existing behaviour of archived sessions, not new to branching. To find an orphan, grep the
backend log for `ChatBranching: branch session created (hidden until verified)` (it carries `sessionId`,
`sourceSessionId`, `userId`); every later failure line (`unexpected failure`, `could not be revealed`, `vanished`,
`idempotency bookkeeping failed`) carries the same `sessionId`. A branch whose reveal succeeded but whose idempotency
bookkeeping failed still answers 201 and keeps its claim (never released once visible).

**Rollback.** Set `chat_branching_enabled` to anything but `true`; the endpoint answers 404 and the portal hides
the action. Branches already created are ordinary sessions and need no cleanup.
