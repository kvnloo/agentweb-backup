# Cycle 80 — MCP generate_image is outside tryClaimSessionGeneration

**UTC:** 2026-09-11T21:34:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 66: `tryClaimSessionGeneration` is the in-memory Set
`keyedMutex.ts` L12–15 assumes. Cycle 79: mcpFetch abort leaves
the leaf running. Does MCP `POST /generate-image` even take that
claim — or can Hermes overlap vendor calls the lock never sees?

## Finding

**The claim is Agent Mode `/generate` only. `emmaApi` generate-image
never calls `tryClaimSessionGeneration`. `keyedMutex` is chatbot
append, not this route. Q-014 listing does not add a lock. A fifth
`listen()` would not either.**

### Who holds the Set

`tryClaimSessionGeneration` (`agentModeController.ts` L951) is
used from that controller (L1002, L1080, L1350, L1629, L9016,
L10290). Zero uses in `emmaApi.ts`.

`emmaApi.ts` L174–182: `authenticateToken` + `requireEmmaTokenBudget`
(ENG-973) then `svc.generateImage(...)`. `session_id || ''` is
passed through; it is not a claim key.

`keyedMutex.ts` L12–15: “a session's generation is guarded by
`tryClaimSessionGeneration` to a single in-flight run, so all
of a session's concurrent appends originate in one process.”
The only prod `withKeyedMutex` sites are `chatbotService.ts`
L1078 / L1134 (`chat-append:${sessionId}`). MCP image gen does
not append chat messages on that path.

Cycle 79’s orphan 8 min vendor call is therefore **unclaimed**.
Hermes can `CallTool` again; a second mcpFetch starts another leaf.
Quota (`requireEmmaTokenBudget`) is the only in-process brake on
this route. Cycle 66’s “A-006 would race the Set” overstated MCP:
there is no Set here to race. HTTP-splitting still would not add
one.

Hermes/OMP: the agent loop is the concurrency bound. AgentWeb MCP
is a tool server; listing `generate_image` (Q-014) is correct and
does not require copying Agent Mode’s claim onto emmaApi. Do not
put `tryClaimSessionGeneration` on MCP (wrong lock: no Agent Mode
turn). Do not Redis-ify. Cutting-edge is keep the hop, meter in
the leaf, quota on the route.

## Queue effect

A-006 stays **discard** (new citation: MCP already unclaimed;
a fifth process is not a lock). Q-014 stays **ready**. A-017
stays park. Cycle 66 lock argument remains for Agent Mode extract,
not for this face.

## Next

Cycle 81: cheapest remaining mapping. Do not un-ready Q-001 /
Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
