# Cycle 143 — Listed MCP `search_knowledge_base` already hops to Agent Mode’s superset; `generate_image` is still hidden

**UTC:** 2026-09-12T00:18:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 142: Agent Mode’s KB method is a Drive/ClickUp
superset. Does listed MCP `search_knowledge_base` already
hop HTTP to that method, while sibling `generate_image` is
still `internal: true`? File-level.

## Finding

**Yes. Q-014 is “do for `generate_image` what KB already
has”: listing, not a new hop.** The hop already exists and
it pulls Drive/ClickUp OAuth onto the Hermes path.

`apiTools.ts` L1264–1284 registers `search_knowledge_base`
with **no** `internal: true`. It sits in the listed catalogue
**before** the “Internal-only tools” banner (L1936–1938).
`execute` is `mcpFetch` POST `/api/emma/search-knowledge-base`.
`emmaApi.ts` L98–101: `getAgentModeService().searchKnowledgeBase(...)`
— the cycle 142 superset (Vertex + Drive + ClickUp). The
route is `metered` (`emmaTokenBudget.ts` L49).

Sibling `generate_image` is still hidden: L2077 `internal:
true`. `mcpToolRegistry.getToolDefinitions()` (`registry.ts`
L82–85) drops `internal`. The contract test pins both sides:
`mcp.apiTools.test.ts` L78 expects `search_knowledge_base`
on the listed set; L91 expects `generate_image` **not** on
`getToolDefinitions()`.

MCP’s listed description (L1268) is thinner than Emma’s
(`emma/tools.ts` L5576): it does **not** mention Drive or
ClickUp, but the hop still walks them. Hermes `tools/list`
therefore advertises a Vertex-shaped name and runs the
superset.

That is already AgentWeb’s composition bus: loopback
mcpFetch to this `listen()`, same shape Q-014 will use for
images. Do not add a fifth `listen()` so KB and images
“match.” Do not un-ready Q-014 — listing images is still
the first product slice; KB being listed is the receipt
that the flag drop is the whole change.

Do not add A-021. Do not vendor `/mcp` instead of Q-014.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Do not add A-021. Q-001 stays **ready**. Q-014 stays
**ready**.

## Next

Cycle 144: cheapest remaining. Candidate: Agent Mode
**re-caps** Vertex at L24065–24067 after ENG-1057 already
capped the leaf (`chatbotService.ts` L4852). The comment at
L24062 (“Vertex results were never capped”) is stale.
File-level. Do not un-ready Q-001 / Q-014 / Q-003.
Unsubscribe after `2026-09-12T06:00:00Z`.
