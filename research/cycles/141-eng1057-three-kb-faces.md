# Cycle 141 — ENG-1057 already named three in-process faces for the KB leaf

**UTC:** 2026-09-12T00:08:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 140: the helper is a Vertex leaf in a cyclic file.
Do three in-process faces already call it — Emma L5106,
Agent Mode L24059, Growth Genius L71 — same shape as
`generate_image`? File-level.

## Finding

**Yes. ENG-1057 already wrote that down.** The test file
header is the receipt, not a new inference.

`chatbotService.searchPlatformKnowledgeBase.test.ts` L1–10:
the function is “the single shared source behind **three
separate consumers** (AgentModeService.searchKnowledgeBase,
GrowthGeniusService.searchKnowledgeBase, chatbotService’s
own platform-KB fallback in generateChatResponse).” A raw
uncapped Vertex hit crashed the **single-instance** backend
(2026-08-10, ~1.5–2 min, 100% of traffic). The fix capped
**at the source** so each consumer does not have to
remember.

Live call sites match the header:

| Face | Citation | How it runs |
|---|---|---|
| Emma chatbot | `chatbotService.ts` L5106 | in-process fallback in `generateChatResponse` |
| Agent Mode | `agentModeService.ts` L24059 | `searchKnowledgeBase` tool |
| Growth Genius | `growthGeniusService.ts` L71 | inline `search_knowledge_base` (cycle 139) |

Same composition lesson as `generate_image` (README finding
3 / Q-014): **policy and caps live in the leaf; faces are
callers.** HTTP-splitting the leaf would put Vertex + the
5000-char cap (L4852) behind a fifth hop that all three
faces would have to retry. The 2026-08-10 outage is why the
cap is here, not in each face.

Do not add A-021. Do not vendor `/mcp` instead of Q-014.
Hermes/OMP: one package, many callers.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Do not add A-021. Q-001 stays **ready**. Q-014 stays
**ready**.

## Next

Cycle 142: cheapest remaining. Candidate: Agent Mode’s
`searchKnowledgeBase` (around L24059) also walks Drive /
ClickUp (`driveScanIncomplete` L24052–24056). Those extra
sources are Agent Mode only — Growth Genius and Emma do not
get them. Three faces, **unequal** source sets. File-level.
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
