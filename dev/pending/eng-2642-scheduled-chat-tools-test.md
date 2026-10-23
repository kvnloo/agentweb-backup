## ENG-2642: a contract change must update every exact-shape assertion on the same call (2026-10-23)

`mcp.scheduledChatTools.test.ts` failed on main from 2026-10-13 until this fix. ENG-1611
(980cd66df0, PR #3521) made the `list_scheduled_chats` MCP tool always send
`queryParams: { limit: '50' }` and therefore receive the paged `{ items, nextCursor }` response.
That PR added its own suite (`eng1611.scheduledChatsPagination.test.ts`) but left the older
exact-object `toHaveBeenCalledWith` in `mcp.scheduledChatTools.test.ts`. Backend CI does not run
jest, so nothing flagged it. Reproduce: the test passes at `980cd66df0~1` and fails at `980cd66df0`.

Lesson: when you change what a tool sends to `mcpFetch`, run
`git grep -l "<tool name>" backend/src -- '*.test.ts'` and run every hit, not only your new suite.
The portal is unaffected: it calls `GET /api/agent-mode/scheduled-chats` with no `limit`/`cursor`,
and the controller keeps returning the old bare array in that case.
