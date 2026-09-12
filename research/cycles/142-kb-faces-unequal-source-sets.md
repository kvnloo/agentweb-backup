# Cycle 142 — Three ENG-1057 faces share the Vertex leaf; Agent Mode is a Drive/ClickUp superset

**UTC:** 2026-09-12T00:12:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 141: ENG-1057 named three in-process faces for the
KB leaf. Does Agent Mode’s `searchKnowledgeBase` also walk
Drive / ClickUp — three faces, **unequal** source sets?
File-level.

## Finding

**Yes. The shared unit is Vertex only. Agent Mode is a
superset.** HTTP-splitting the leaf would not give Emma RAG
or Growth Genius Drive/ClickUp. Extracting Agent Mode’s
whole method would pull those OAuth clients into a fifth
process.

ENG-1057’s three consumers (`chatbotService.searchPlatformKnowledgeBase.test.ts`
L1–10) all call the Vertex leaf. After that call, the faces
diverge:

| Face | Citation | Vertex leaf | Drive | ClickUp | Local in-memory chunks |
|---|---|---|---|---|---|
| Agent Mode tool | `agentModeService.ts` L24059 then L24072 / L24141 / L24181 | yes | yes (`getUserGoogleDriveFolders`, ENG-1624 tree) | docs + tasks | no |
| Emma RAG | `chatbotService.ts` L5093 then L5106 | yes | no | no | yes (`searchKnowledgeBase` L4674 → `findRelevantChunks`) |
| Growth Genius | `growthGeniusService.ts` L71 | yes | no | no | no |

Emma **tool** is not the RAG path. `emma/tools.ts` L5573–5594
describes Drive + ClickUp and `execute`s
`agentModeService.searchKnowledgeBase`. In-app Emma on the
`knowledge-base` page (`chatbotService.ts` L5213) therefore
gets the superset; the RAG fallback in `generateChatResponse`
does not. `chatbotService.ts` has zero `clickup` / Drive
imports.

Agent Mode also **re-caps** Vertex at L24065–24067 even though
ENG-1057 already capped the leaf (`chatbotService.ts` L4852).
The comment at L24062 (“unlike the Drive/ClickUp sources
below, Vertex results were never capped”) is stale after
ENG-1057. Do not treat that as a new ticket this cycle.

MCP listed `search_knowledge_base` (`apiTools.ts` L1264–1284,
no `internal: true`) `mcpFetch`es `POST /api/emma/search-knowledge-base`
(`emmaApi.ts` L98–101) which calls **this** Agent Mode method
— so Hermes already runs the superset. That hop is cycle 143.

Do not add A-021. Do not vendor `/mcp` instead of Q-014.
Hermes/OMP: one package, many callers, **one source set per
name**. AgentWeb’s same name covers different sources by face.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Do not add A-021. Q-001 stays **ready**. Q-014 stays
**ready**.

## Next

Cycle 143: cheapest remaining. Candidate: listed MCP
`search_knowledge_base` already hops HTTP to Agent Mode’s
superset (`emmaApi.ts` L98–101) while sibling `generate_image`
is still `internal: true` (`apiTools.ts` L2077). File-level.
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
