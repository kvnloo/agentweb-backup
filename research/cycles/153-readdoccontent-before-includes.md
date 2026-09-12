# Cycle 153 — `readDocContent` lists pages and may GET each page before Agent Mode’s `includes()`; `nameMatch` does not skip the fetch

**UTC:** 2026-09-12T00:26:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 152: `listTasks` enriches attachments search ignores.
Does ClickUp `readDocContent` (`clickupService.ts` L134–175)
list pages then maybe GET each page **before** Agent Mode’s
`includes()` (L24155–24158) — non-matching docs still pay
the page tree? File-level.

## Finding

**Yes. `nameMatch` is computed first and unused as a skip.**

Agent Mode L24155: `doc.name.toLowerCase().includes(queryLower)`.
L24156 **always** `await readClickUpDocContent(...)`. L24158
then `content.toLowerCase().includes`. The `if (nameMatch ||
contentMatch)` (L24159) runs **after** the fetch. A name
miss still pays the page tree so content can be grepped.

`readDocContent` L131–175: “fetching all its pages and
concatenating them.” Step 1 GET
`/docs/${docId}/pages` (L137–141). Step 2: for each page,
if `pageSummary.content` is empty, GET
`/pages/${pageId}` (L156–165). One list + up to one GET per
page, **per doc**, including docs that will not match.

Drive in the same method reads **after** `fullText contains`
(L24104–24109). ClickUp reads to decide whether it matched.

Listed MCP hops here (`emmaApi.ts` L98–101). HTTP-splitting
`searchKnowledgeBase` would still call this `readDocContent`.
Hermes/OMP: search port first, read hits. An in-process
name-first skip (or a ClickUp search API) is the modular
monolith move. Do not add A-021. Do not patch the skip on
this research turn.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-011 stays
**park**. A-006 stays **discard**. Do not add A-021. Q-001
stays **ready**. Q-014 stays **ready**.

## Next

Cycle 154: cheapest remaining. Candidate: Drive
`readGoogleDriveFileContent` only for files that already
matched `fullText` (L24104–24109) — search-then-read —
while ClickUp is read-then-filter. File-level. Do not
un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
