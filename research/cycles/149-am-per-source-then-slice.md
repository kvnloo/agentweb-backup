# Cycle 149 — Agent Mode collects `limitedMaxResults` per source, then slices; Vertex-first prefix can discard Drive/ClickUp after paying for them

**UTC:** 2026-09-12T00:20:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 148: cardinality is per-face (5 vs 10). Does Agent
Mode collect up to `limitedMaxResults` **per source** then
`results.slice(0, limitedMaxResults)` (L24230–24233), so a
default-5 call can still walk Drive+ClickUp and throw most
of it away? File-level.

## Finding

**Yes. The comment is the receipt.** L24230–24233: each
source is collected independently, “so the merged list can
be several times larger than requested — cap it to avoid
context bloat.” `boundedResults = results.slice(0,
limitedMaxResults)` (L24233). `hasMore` only reports that
**merge** cut (L24249); L24245–24248 already say a per-source
cap can hide more upstream.

Order of `results.push`:

1. Vertex leaf first (L24059–24070)
2. Drive tree walk ENG-1624 (L24080–24121), including
   **sequential** `readGoogleDriveFileContent` per file
3. ClickUp docs: `listClickUpDocs` then `readClickUpDocContent`
   per doc until `limitedMaxResults` matches (L24141–24163)
4. ClickUp tasks (L24181+)

`slice(0, N)` keeps the **prefix**. If Vertex already returned
N hits, Drive and ClickUp rows are dropped **after** OAuth,
folder-tree walk, and per-file/doc reads. Listed MCP
`search_knowledge_base` hops here (`emmaApi.ts` L98–101,
cycle 143). Hermes on `/mcp` pays for discarded sources.

Growth Genius and Emma RAG never enter this method (cycle
142) — they call the Vertex leaf only. The waste is the
**superset face**, including the already-listed MCP tool.

HTTP-splitting the method would copy this fan-out-then-discard
into a fifth process. Hermes/OMP: one handler that stops when
the caller’s N is filled. Do not add A-021. Do not rewrite
the merge on this research turn.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-011 stays
**park**. A-006 stays **discard**. Do not add A-021. Q-001
stays **ready**. Q-014 stays **ready**.

## Next

Cycle 150: cheapest remaining. Candidate: there is **no**
`if (results.length >= limitedMaxResults) skip Drive/ClickUp`
between L24070 and L24073. Vertex filling the cap does not
short-circuit. File-level. Do not un-ready Q-001 / Q-014 /
Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
