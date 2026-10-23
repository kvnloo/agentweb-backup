## ENG-2648: branch copies no longer counted twice by scoring, eval and admin readers (2026-10-23)

A branch ("Branch from here", ENG-112/113) is an ordinary new session whose rows `[0..k]` are a COPY of its
source (`buildBranchRows`, `services/agentMode/chatBranching.ts`). Billing was already clean: the copy strips
`usage` (so `incrementTokenUsage` adds nothing), `addMessagesToSession` charges no quota (ENG-1134),
`totalCost`/`toolCosts` are session fields that are not copied, and AW-SpendEvents rows reference the source
session. What did double-count: every reader that treats the branch's rows as its own work.

- Satisfaction scoring (`attemptSessionScore`, `judgeCohortExclusion`): a never-continued branch, and the
  archived leftover of a failed copy, were scored as a full chat (a pure duplicate of the source's turns).
- Eval-v2 graders (`buildLoadedSession`): copied tool calls, user turns and the final reply were graded again.
- Admin `GET /api/admin/chat-sessions` recent list (and so the `get_chat_history` MCP tool / Daily
  Satisfaction report): listed failed-copy leftovers (born `archived: true`, never revealed) and
  never-continued branches, and created iShare review links on them; `get_chat_history` attributed the
  copied turns' models, waits and heap to the branch.

Fix: `branchOwnMessages(messages)` returns the rows from the branch's first OWN user message on (a user row
after the branched-from assistant row, or written after `branchOrigin.branchedAt`); a non-branch is returned
unchanged. Those four readers use it. The `?sessionId=` admin lookup still finds any session by id, so an
orphan named in a `ChatBranching: unexpected failure` log line can still be inspected.

Orphan sweep: not built. Leftovers are hidden (archived) and are now excluded from every reader above.
If they ever need removing, that is a data-plane delete (Harsha): candidates are sessions with
`archived = true`, a `branchedFrom` attribute and no own user row per `branchOwnMessages` — a user-archived
branch that was continued has own rows and must be kept.
