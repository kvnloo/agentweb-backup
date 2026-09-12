# Cycle 145 — Three TypeScript `searchKnowledgeBase` symbols; Emma’s export is Azure embeddings over in-memory docs, not the Vertex leaf

**UTC:** 2026-09-12T00:32:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 144: Agent Mode still recaps Vertex. Does Emma chatbot
export a **different** `searchKnowledgeBase` (`chatbotService.ts`
L4674) than Agent Mode’s method of the same name (L24032)?
Two contracts, one string? File-level.

## Finding

**Yes. Three functions, one identifier, four retrieval
engines.** Hermes/OMP: one name in the catalog maps to one
handler. AgentWeb’s same string is three signatures.

| Symbol | Citation | Signature | What it actually searches |
|---|---|---|---|
| `chatbotService.searchKnowledgeBase` | L4674–4678 | `(query, maxResults=5) → ContextChunk[]` | In-memory `knowledgeBase` (L4293) via `findRelevantChunks` (L515–548): **Azure OpenAI embeddings**, cosine similarity. No `userId`. ENG-163 docs test (`chatbotService.docsKnowledgeBase.test.ts` L80). |
| `AgentModeService.searchKnowledgeBase` | L24032 | `(query, maxResults=5, userId?) → any` | Vertex leaf + Drive + ClickUp (cycle 142). Emma tool (`emma/tools.ts` L5593) and listed MCP (`emmaApi.ts` L101) call **this**. |
| `GrowthGeniusService.searchKnowledgeBase` | L66–71 | `(query, userId) → any[]` | Vertex leaf only. Inline tool schema (L129–150) also requires `reason`, which Emma/MCP do not. |

Emma RAG (`generateChatResponse` L5093) calls the **embeddings**
export first, then the Vertex leaf (L5106). It never calls
Agent Mode’s method. So one chat turn can hit Azure embeddings
**and** Vertex without Drive, while the same tool name on
MCP/Emma-tool hits Drive.

HTTP-splitting “searchKnowledgeBase” cannot pick a process
until the name is one contract. A-007/A-008 extract the
**leaf** (`searchPlatformKnowledgeBase`), not these three
wrappers. Do not add A-021. Do not rename on this research
turn.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Do not add A-021. Q-001 stays **ready**. Q-014 stays
**ready**.

## Next

Cycle 146: cheapest remaining. Candidate: Growth Genius’s
inline `search_knowledge_base` requires `reason`
(`growthGeniusService.ts` L142–147); Emma (`emma/tools.ts`
L5577–5590) and MCP (`apiTools.ts` L1269–1276) do not. Same
name, three schemas. File-level. Do not un-ready Q-001 /
Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
