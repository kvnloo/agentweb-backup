# Cycle 147 — Growth Genius `reason` is required on the schema and discarded before the leaf

**UTC:** 2026-09-12T00:22:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 146: GG’s inline tool requires `reason`. Does execute
use it, or is it prompt-only? File-level.

## Finding

**Prompt-only. The required field never reaches Vertex.**

`growthGeniusService.ts` L147 marks `reason` required. L174
logs `functionArgs.reason`. L177 calls
`this.searchKnowledgeBase(functionArgs.query, userId)` —
**query only**. The method (L66–71) forwards that query to
`searchPlatformKnowledgeBase(query, 10, userId)`. The tool
result posted back to the model (L188–192) is
`{ query, results, count }` — no `reason`.

So a Hermes-shaped one-catalog merge that dropped `reason`
to match Emma/MCP would not change what Growth Genius
retrieves. The field is a chain-of-thought hint for the
first `callLLM` (L125), not a port on the leaf.

Cycle 39’s `confirm` on `generate_image` **does** reach
policy (`emma/tools.ts` → `generateImage`). A-011 parks
unifying that because it **changes HITL**. GG `reason` is
the opposite: unifying it away is a no-op on the leaf.
Still not a nanoservice, and still not a reason to un-ready
Q-014.

Do not add A-021. Do not edit `growthGeniusService.ts` on
this research turn. `#1076` is `chatbotService.ts`.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-011 stays
**park**. A-006 stays **discard**. Do not add A-021. Q-001
stays **ready**. Q-014 stays **ready**.

## Next

Cycle 148: cheapest remaining. Candidate: GG hardcodes
`maxResults=10` at L71; Emma/MCP default `max_results` 5
then Agent Mode `Math.min(maxResults, 10)` (L24050). Same
name, different cardinality. File-level. Do not un-ready
Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
