# Cycle 140 — `searchPlatformKnowledgeBase` is a leaf trapped in a file that cycles with `agentModeService`

**UTC:** 2026-09-12T00:06:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 139: Growth Genius executes Emma’s
`searchPlatformKnowledgeBase`. Does that function import
`agentModeService` (DAG inversion), or is it a leaf Growth
Genius can keep calling after A-002? File-level.

## Finding

**The function is a leaf. The file is not. A-002 does not
apply.**

`searchPlatformKnowledgeBase` (`chatbotService.ts` L4711–4867)
talks to Vertex Discovery Engine (`SearchServiceClient`, lazy
`@google-cloud/discoveryengine`, ENG-1277). GCS key via
`getGCSPPrivateKey`. No `AgentModeService`. No `callLLM`.
Returns `ContextChunk[]` or throws.

The **module** is the Emma god-file:

| Fact | Citation |
|---|---|
| File imports `AgentModeService` | L24 |
| Emma chat constructs it | `generateChatResponse` L4983 `new AgentModeService()` then `callLLM` L5376 |
| `agentModeService.ts` imports the leaf **from this file** | L26: `chatbotDb, ChatMessage, searchPlatformKnowledgeBase` |

That is a **require cycle**: chatbotService → AgentModeService
→ chatbotService. Growth Genius L1–2 imports **both** sides, so
one Growth Genius turn already loads the cycle.

A-002 is `loops/core` + `loops/index.ts` only. This helper is
not in `loops/`. Extracting the function to its own module
(OMP package shape, like A-008’s path shim) would let Growth
Genius and Agent Mode share a leaf without importing Emma
chat. HTTP-splitting it is A-006. `#1076` already touches
`chatbotService.ts` — park any extract until that PR is gone.

Do not add A-021. Do not vendor `/mcp` instead of Q-014.
Hermes/OMP: KB search would be `pi-ai`-adjacent package, not
a fifth listen().

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. A-002 stays **ready** (does not cover this file).
Do not add A-021. Q-001 stays **ready**. Q-014 stays **ready**.

## Next

Cycle 141: cheapest remaining. Candidate: three in-process
faces already call this leaf — Emma `generateChatResponse`
L5106, Agent Mode L24059, Growth Genius L71. Same shape as
`generate_image`’s three faces. File-level.
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
