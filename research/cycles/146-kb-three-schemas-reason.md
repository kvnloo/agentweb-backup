# Cycle 146 — Same `search_knowledge_base` name, three JSON schemas; Growth Genius requires `reason`

**UTC:** 2026-09-12T00:16:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 145: three TypeScript `searchKnowledgeBase` symbols.
Does Growth Genius’s inline `search_knowledge_base` require
`reason` (`growthGeniusService.ts` L142–147) while Emma and
MCP do not? Same name, three schemas? File-level.

## Finding

**Yes. One name, three input contracts.** This is the KB
analog of cycle 39 / **A-011** (`generate_image`: Emma has
`confirm`, MCP does not). Do not add A-021 to unify KB
schemas. Q-014 stays list-only for images.

| Catalog | Citation | Required | Extra fields | Description mentions Drive/ClickUp |
|---|---|---|---|---|
| Growth Genius inline | `growthGeniusService.ts` L129–147 | `query`, **`reason`** | `reason` only | no |
| Emma `emmaToolRegistry` | `emma/tools.ts` L5577–5590 | `query` | `max_results` default 5 | **yes** (L5576) |
| MCP `mcpToolRegistry` | `apiTools.ts` L1269–1276 | `query` | `max_results` default 5 | no (L1268) |

Agent Mode’s `getAvailableTools()` test
(`agentModeService.searchKnowledgeBase.test.ts` L66–74)
pins Emma’s shape: `query` + `max_results`, required
`query` only. No `reason`.

Hermes/OMP: one handler table, one schema per name.
AgentWeb already refused to unify `generate_image` inside
Q-014 (A-011 park). Merging these three KB schemas would
be a second A-011, not a nanoservice. A fifth `listen()`
would still need to pick **one** of these contracts.

Do not un-ready Q-014. Listing images does not require KB
schema unification. `#1076` touches `chatbotService.ts`;
do not edit `emma/tools.ts` (#2832).

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-011 stays
**park**. A-006 stays **discard**. Do not add A-021. Q-001
stays **ready**. Q-014 stays **ready**.

## Next

Cycle 147: cheapest remaining. Candidate: Growth Genius
**logs** `reason` (L174) and never passes it to
`this.searchKnowledgeBase(functionArgs.query, userId)`
(L177). Required field is prompt-only. File-level. Do not
un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
