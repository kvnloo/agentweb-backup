## ENG-112: Branch family link and GET /session/:id/branches (2026-10-12)

A branch used to be tied back to its source only by `metadata.branchOrigin` on its first message row, so a chat could not list its branches and the sidebar could not group them.

- New optional session attribute `branchedFrom: { sessionId, rootSessionId, messageIndex, branchedAt }`, written once when a branch is created (born archived, revealed after verification, like the rest of the branch). `sessionId` is the immediate source, `rootSessionId` is the source's root (or the source itself), so a branch of a branch stays in one family. Never copied from the source.
- `GET /api/agent-mode/sessions` and `GET /api/agent-mode/session/:id` return it for the owner. Share, conversable, ishare and MCP views do not (MCP strips it explicitly; the share serializers pick fields by name).
- New `GET /api/agent-mode/session/:sessionId/branches` (auth, owner only, same `chat_branching_enabled` flag, 404 `chat_branching_disabled` when off): the root plus every non-archived session of the same owner with that root, createdAt ascending, max 50. One paginated, projected query over the existing `UserIdIndex` (no scan, no new GSI); reads stop after 20 pages or once 49 branches are found and report `truncated: true`. Cost is one indexed pass over the owner's sessions (typical user has <1000).
- Legacy branches made before this change have no `branchedFrom` (only the row-0 `branchOrigin`). They are NOT grouped: finding them would mean reading message rows for every session. No backfill.

Data plane: owner-approved additive optional attribute; no GSI, no backfill, rollback = stop writing/reading (the attribute is ignored by every other reader; existing items with it are harmless).
