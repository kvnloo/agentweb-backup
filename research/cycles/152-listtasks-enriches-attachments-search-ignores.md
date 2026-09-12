# Cycle 152 — `listTasks` enriches every task’s attachments; `searchKnowledgeBase` only reads name + description

**UTC:** 2026-09-12T00:26:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 151: ClickUp docs search is list-all then filter.
Does `listTasks` (`clickupService.ts` L219–258) paginate
**all** tasks and then `getTask` attachments in batches of
10, while `searchKnowledgeBase` only uses `name` +
`description` (L24194–24196)? File-level.

## Finding

**Yes. One adapter, two callers, search pays for list’s
enrichment.**

`clickupService.ts` L214–218: “List all tasks in a workspace
(paginated via v2 API). Enriches each task with attachment
data from individual task fetches.” L219–233 pages until
`last_page`. L237–258: for **every** mapped task with empty
`attachments`, `getTask` in batches of 10.

Agent Mode search (L24190–24196) then:
`listClickUpTasks` → `name.toLowerCase().includes` and
`(task.description || '').includes`. Comment L24181:
“no full content fetch needed.” Attachments are never read.

`listKnowledgeBaseFiles` **does** use
`attachmentCount: task.attachments.length` (L24878–24887).
So the enrichment is real for the **list** tool. Search
reuses the same `listTasks` and inherits the N extra
`getTask` calls.

Hermes/OMP: one function per contract. AgentWeb’s in-process
fix is a lean list-for-search (or skip enrichment when the
caller will not read attachments) — a package split, not a
fifth `listen()`. HTTP-splitting `searchKnowledgeBase` would
still call this `listTasks`. Do not add A-021. Do not edit
`clickupService.ts` on this research turn.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-011 stays
**park**. A-006 stays **discard**. Do not add A-021. Q-001
stays **ready**. Q-014 stays **ready**.

## Next

Cycle 153: cheapest remaining. Candidate: ClickUp docs
`readDocContent` (L134–175) lists pages then may GET each
page **before** Agent Mode’s `includes()` (L24155–24158) —
non-matching docs still pay the page tree. File-level. Do
not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
