# Cycle 78 — leaf image timeout is 8 min; MCP mcpFetch is 5

**UTC:** 2026-09-11T21:30:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 77: MCP `generate_image` mcpFetch aborts at 5 min. Does the
leaf agree, or does in-process Agent Mode get a longer vendor clock
that the Hermes hop cannot use?

## Finding

**The leaf is 8 min (ENG-510). MCP’s 5 min default is a stricter
face, not the vendor cap. Three faces, two clocks. Align with
`timeoutMs` on this PORT after Q-014 lists; do not HTTP-split.**

### ENG-510’s 8 min vs mcpFetch’s 5

`imageGeneration.ts` L69–79 `IMAGE_GENERATION_TIMEOUT_MS` default
**8 min**: must stay **below** `GENERATION_TIMEOUT_MS` 10 min
(`agentModeController.ts` L1100–1101) so a hung provider leaves
~2 min for failover / wrap-up. Applied at L537–542 `withTimeout`.
Retry envelope `retryWithBackoff` L440–446 defaults to **5 min
total** — a third number inside the same class.

MCP `generate_image` (`apiTools.ts` L2096–2108) does not pass
`timeoutMs`, so `httpClient.ts` L205 aborts at **5 min** — before
the leaf’s 8 min `withTimeout` can fire, and before ENG-510’s
failover window exists on that hop.

| Face | Clock | Citation |
|---|---|---|
| Agent Mode / chatbot `executeTool` | leaf 8 min | in-process, no mcpFetch |
| MCP Hermes Q-014 | mcpFetch **5 min** then leaf 8 | cycle 77 + this |
| A-006 fifth `listen()` | would be a fourth | none of ENG-510’s coupling to the 10 min turn |

`timeoutMs: 8 * 60 * 1000` on the existing mcpFetch would sit
inside nginx/ALB 10 min (cycle 76) and drain 10 min. That is the
in-process align. Do not do it instead of listing (Q-014). Do
not copy `IMAGE_GENERATION_TIMEOUT_MS` onto a new process that
cannot see `GENERATION_TIMEOUT_MS`.

Hermes/OMP: one timeout around `execute()`. AgentWeb already has
two on the same leaf because MCP added a hop. A-006 would add a
third. Cutting-edge is one `timeoutMs` on the hop that exists.

## Queue effect

A-006 stays **discard**. Q-014 stays **ready** (list ≠ timeout
align). A-017 stays park. No new A-id — `timeoutMs` rides A-007’s
`infrastructure.ts` or a one-line follow-up after #2.

## Next

Cycle 79: cheapest remaining mapping. Do not un-ready Q-001 /
Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
