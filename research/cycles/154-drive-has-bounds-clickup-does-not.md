# Cycle 154 — Drive search already has count + time bounds (ENG-1624); ClickUp docs search has neither

**UTC:** 2026-09-12T00:30:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 153: ClickUp reads pages before `includes()`. Does
Drive already bound **count and time** on the same search
path (ENG-1624), while ClickUp docs search has neither?
File-level.

## Finding

**Yes. Drive is the in-process pattern to copy, not a
fifth process.**

`agentModeService.ts` L23552–23558 (ENG-1624):
`getGoogleDriveFolderTreeIds` bounds folder **count**;
`queryDriveFilesAcrossFolders` bounds per-batch file
**count** (`perBatchTarget`, L23874–23879). Neither used to
bound elapsed **time**; both now share
`DRIVE_LIST_WALK_MAX_MS = 90_000` (L23581) plus a
per-request deadline from remaining budget (L23583–23597).
Search passes `limitedMaxResults` as `perBatchTarget`
(L24089–24094) with `fullText contains`.

ClickUp docs on the same method:

- `listDocs` (`clickupService.ts` L106–119): `do/while
  (cursor)`, `limit: 100`, **no** deadline, **no** query
- `readDocContent` L134–175: sequential page GETs, **no**
  deadline
- Agent Mode loop L24152–24156: sequential `await` per doc
  until N **matches**, not until a clock

Grep of `clickupService.ts` for `TIMEOUT` / `MAX_MS` /
`deadline` / `AbortSignal` / `timeout` is **empty**.
ClickUp search can stall a listed MCP turn the way an
unbounded Drive walk used to (comment cites ENG-1584
wrong-absence).

HTTP-splitting `searchKnowledgeBase` would not add a
ClickUp deadline. Hermes/OMP: bounds live in the adapter
package. Copy Drive’s bound **shape** onto ClickUp
in-process. Do not add A-021. Do not add the timer on this
research turn.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-011 stays
**park**. A-006 stays **discard**. Do not add A-021. Q-001
stays **ready**. Q-014 stays **ready**.

## Next

Cycle 155: cheapest remaining. Candidate: Drive folder trees
are `Promise.all` (L24080); ClickUp docs loop is sequential
`await` per doc (L24152–24156) with no `sharedDeadlineAt`.
File-level. Do not un-ready Q-001 / Q-014 / Q-003.
Unsubscribe after `2026-09-12T06:00:00Z`.
