# Cycle 150 — Vertex filling the cap does not skip Drive or ClickUp; there is no short-circuit

**UTC:** 2026-09-12T00:24:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 149: per-source collect then slice can discard
Drive/ClickUp. Is there a
`if (results.length >= limitedMaxResults) skip`
between Vertex (L24070) and Drive (L24073)? File-level.

## Finding

**No short-circuit.** After the Vertex map (L24070) the next
statement is `if (userId)` Drive (L24073). ClickUp docs
(L24142) and ClickUp tasks (L24182) are the same shape:
userId only, not “cap already full.”

The only `results.length` gate in this method before return
is **empty-set** (`L24216`: `=== 0`). Grep of
`agentModeService.ts` has no
`results.length >= limitedMaxResults` in
`searchKnowledgeBase`. Drive still walks the folder tree
(ENG-1624) and ClickUp still `getClickUpAccessToken` +
`listClickUpDocs` even when Vertex already returned N hits
that `slice` will keep.

Cycle 149 is discard-after-pay. This cycle is
**never-skip**. Together they mean listed MCP
(`emmaApi.ts` L98–101) always fans out the superset when
`userId` is present. Growth Genius / Emma RAG never enter
this method (cycle 142) — they do not pay this tax.

HTTP-splitting would not add the missing `return`. Hermes/OMP:
one handler, stop when N is filled. An in-process early
return is the modular-monolith move; a fifth `listen()` is
not. Do not add A-021. Do not patch the skip on this
research turn.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-011 stays
**park**. A-006 stays **discard**. Do not add A-021. Q-001
stays **ready**. Q-014 stays **ready**.

## Next

Cycle 151: cheapest remaining. Candidate: ClickUp docs
`listClickUpDocs` the **whole** workspace (L24150) then
`readClickUpDocContent` per doc (L24156) until N matches —
list-all then filter, not a search API. File-level. Do not
un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
