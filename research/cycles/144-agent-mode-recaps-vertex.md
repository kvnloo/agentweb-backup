# Cycle 144 — Agent Mode still recaps Vertex after ENG-1057 capped the leaf; the “never capped” comment is stale

**UTC:** 2026-09-12T00:24:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 143: listed MCP already hops to Agent Mode’s KB
superset. Does Agent Mode still recap Vertex at L24065
after ENG-1057 capped the leaf, with a stale “never capped”
comment? File-level.

## Finding

**Yes. Policy is duplicated, not missing.** ENG-1057 moved
the 5000-char cap into the shared leaf so each consumer
would not have to remember. Agent Mode still remembers, and
its test mocks the leaf so the face cap is what it proves.

Leaf (the source ENG-1057 named):

- Public: `chatbotService.ts` L4800–4804 — “cap here, at the
  shared source, so every consumer … is protected uniformly”
- Private: L4852 — “same cap as the public branch above”
- Test: `chatbotService.searchPlatformKnowledgeBase.test.ts`
  L96 / L156 pins the truncated marker on the leaf

Face (still a second copy):

- `agentModeService.ts` L24062–24067: comment says Vertex
  “were never capped”; then `substring(0, 5000)` + the same
  `[Content truncated]` marker
- `agentModeService.searchKnowledgeBase.test.ts` L321–334
  repeats that comment and mocks
  `searchPlatformKnowledgeBase` to return 6000 chars. The
  leaf never runs. Removing the leaf cap would not fail this
  test; removing the face cap would.

Drive / ClickUp caps at L24113 / L24161 / L24199 are the
ones that still belong on the face — those sources are
Agent Mode only (cycle 142). The Vertex recap is the
leftover of “each consumer remembers.”

Composition: Hermes/OMP keep one truncation in the package.
AgentWeb’s leaf + face is defense-in-depth for a mocked
unit test, not a reason to HTTP-split either layer. Do not
open a product PR on this research turn to delete the
duplicate. Do not add A-021.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Do not add A-021. Q-001 stays **ready**. Q-014 stays
**ready**.

## Next

Cycle 145: cheapest remaining. Candidate: Emma chatbot
exports a **different** `searchKnowledgeBase` (`chatbotService.ts`
L4674 → in-memory `findRelevantChunks`) than Agent Mode’s
method of the same name (L24032). Two contracts, one string.
File-level. Do not un-ready Q-001 / Q-014 / Q-003.
Unsubscribe after `2026-09-12T06:00:00Z`.
