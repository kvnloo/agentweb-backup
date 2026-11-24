## ENG-2840: memory readers return every memory up to a bound instead of one page, and the memory tool bodies move to one shared module (2026-11-23)

Wave 2, slice W2-1. No new tool and no new route; it repairs what Emma and the Settings memory screens read, and it moves the four memory tool bodies (`save_memory`, `delete_memory`, `save_org_memory`, `delete_org_memory`) into `backend/src/emma/impl/memory.ts` so the MCP memory tools of the next slice can share one set of guards.

### The bug this fixes

A memory row carries a 1,536-number embedding, about 17 KB, and one DynamoDB query page holds at most 1 MB, so one page is 56 to 60 rows. `accountMemoryDb.getUserMemories` returned after the first page that held any ordinary row, and `orgMemoryDb.getOrgMemories` was one unpaged query. Memory ids are ULIDs and the query reads oldest first, so an account with more memories than one page showed only its OLDEST 56 or so, to Emma's prompt and to the Settings memory screen alike. On 2026-11-23 that was 14 of the 52 accounts with memories (and one org); the largest account stores 277 and its page returned 56. Every memory saved after the first page was invisible.

### What changed

- `getUserMemories` and `getOrgMemories` take a fourth argument, `options: { maxRows?, newestFirst?, omitEmbeddings? }`. A call with a `limit` behaves exactly as before. A call without one follows the cursor until the rows run out or `maxRows` is reached.
  - The prompt loader (`agentModeService`) is unchanged and gets the defaults: the **newest 200** rows (`MEMORY_READ_MAX_ROWS_PROMPT`), embeddings included because it ranks by them.
  - `GET /api/memory` and `GET /api/org/:orgId/memory` read the **newest** rows up to **1,000** and return them **oldest first** as before (so the screen order does not change; if an account ever held more than 1,000, it is the oldest that are left out, never the newest). They do **not fetch the embedding vectors at all**: the read names every other attribute (a DynamoDB projection, checked against the real service on the account table and the category index of both tables). The portal never reads the vectors; they were about 40 of every 45 KB of a row on the wire. A category-filtered list is returned as read, because its index sorts by category, not by time.
  - A read that stops at its bound logs a `[memory] ... stopped at its N-row bound (there may be more rows stored)` warning (DynamoDB returns a cursor whenever the limit was used up, even when nothing is left, so an account with exactly the bound's number of rows logs it too).
  - `maxRows` and `newestFirst` are ignored when a `limit` is passed (that call keeps its old behaviour and order).
- The account reader's page budget grows with the bound (ten pages for a `limit` call, as before). It still fails closed rather than return a partial answer. The org reader still does not validate rows (it never did; one odd row must not take the whole org list or every member's prompt down), and the account reader still fails closed on an item that is not a row at all (not an object, or no string id), on a page that is not a list, and on any row when the read has a `limit` (`getRecentMemories` and limited callers are exactly as before). The one change: the read without a `limit` (the prompt loader and the list screens) now reaches rows far past the first page, so a row that has an id but no text `content` (nothing to show or rank) is skipped and logged (`[memory] account memory read skipped N row(s) without text content, ids ...`) instead of failing the whole list and every prompt for that account. A bound that is not a number, zero or negative falls back to the default; a fraction rounds down, never below 1. (Checked on prod on 2026-11-23: no row in either memory table lacks a string `content` or `memoryId`.)
- `setMemoryEmbedding` (both tables) is now conditional on the row existing and ignores a row deleted in the meantime. It was an unconditional upsert: a memory deleted while its embedding was being backfilled came back as a row with no content, which makes the account reader refuse the whole list.
- `deleteMemory` (both tables) resolves `true` when a row was deleted and `false` when there was none. A delete of a missing id used to answer "deleted".
- The memory category list moved to `utils/memoryCategories.ts`, one source for the database layer and the new module.

### Tool defects fixed on the way (all in `emma/impl/memory.ts`)

- An invalid category used to be embedded, and the embedding billed to the caller's cap, before the database layer refused it. The arguments are now checked first.
- Whitespace-only content over 2,000 characters split into nothing and answered `success: true` with no row saved. It is now refused ("Content is required"). A call with no arguments object at all now answers `Invalid category: undefined` instead of a `TypeError`.
- Content that was not text threw after the earlier rows were saved, so a retry saved them twice. It is now refused before anything is written.
- The 8,000-character limit was enforced only by the agent-mode tool schema. It is enforced in the shared module too, so a caller that skips that schema cannot write a larger memory.
- `delete_memory` / `delete_org_memory` of an id that does not exist now answer `success: false` ("not found; nothing was deleted").
- The `delete_org_memory` description said only owners can delete; owners and admins can (`org:configure`). The description now says so.

### Save routes and the embedding bill

- `POST /api/memory` and `POST /api/org/:orgId/memory` embedded the text, billed to the caller's cap, before `addMemory` refused an invalid category, a blank content or a content over 2,000 characters. They now run the same checks, with the same messages and the same 400, before the embedding is requested (`utils/memorySaveGuard.ts`; a test pins that its messages equal `addMemory`'s). A valid save is unchanged.

### What an end user sees

- Emma: for an account past one page, her memory context now includes the newer memories as well (still the top 20 by relevance, as before). Nothing changes for an account with 56 or fewer memories.
- Settings, memory and org memory tabs: an account past one page sees all its memories (up to 1,000) instead of the first ~56. The tabs have no pagination, so it is one longer list. The response is much smaller per row because the vectors are gone.
- Emma's save and delete memory tools: the same answers, except the edge cases above, which are now errors or a "not found" instead of a false success.
- No cap on how many memories an account may save is added here (the MCP write cap belongs to the next slice).
- Unchanged on purpose: `DELETE /api/memory/:id` and `DELETE /api/org/:orgId/memory/:id` still answer success for an id that does not exist (the portal behaves as today); only the Emma tools say "not found".

### Limits, stated

- The prompt loader reads at most the newest 200 rows. An account above that keeps its memories, but Emma ranks among the newest 200 only: for the largest account today (277 rows) facts 1 to 77 stay out of her prompt, where before 221 of 277 did (the old reader returned one page of 56 rows, measured on prod). It costs about four sequential queries per agent turn for that account, against one before. The Settings list reads up to 1,000.
- A 200-row read for the prompt is about 3.4 MB stored and about 9 MB of DynamoDB JSON on the wire for an account with an embedding on every row (about 45 KB of JSON per row; the largest account today is 277 rows). It was up to one page before. The parse and unmarshal (about 100 ms each at 200 rows, measured with the aws-sdk v2 converter on synthetic rows) run in the forked generation worker (the main generation path), not on the API event loop, and the loader reads once per turn. The Settings lists no longer fetch the vectors, so they stay small. Only 16 of 2,411 rows lacked an embedding on 2026-11-23, so the backfill the loader does for them stays negligible.
- A read through an eventually consistent index can lag a save made a moment earlier; the tools answer with the saved ids.
- Rollback is a revert of the PR (code only; no data, schema or index changed).
