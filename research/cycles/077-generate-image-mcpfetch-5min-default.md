# Cycle 77 — generate_image mcpFetch aborts at 5 min, inside nginx 10

**UTC:** 2026-09-11T21:28:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 76: nginx/ALB cut `/mcp` at 600s. Q-014 `generate_image` is
localhost mcpFetch on that path. Is the inner hop the same 10 min,
or a tighter clock — and would a fifth `listen()` inherit it?

## Finding

**The binding clock is mcpFetch’s default 5-minute AbortController,
not nginx. `generate_image` does not pass `timeoutMs`. Landing-page
tools already raise `timeoutMs` in-process (25 min) rather than
extracting a service. A fifth hop would be a fourth clock.**

### Stacked timeouts on this PORT

| Clock | Bound | Citation |
|---|---|---|
| mcpFetch abort | **5 min default** | `httpClient.ts` L48–49 / L204–206 |
| undici Agent | 15 min headers/body | `httpClient.ts` L12–18 (comment: v0 can take 2–5 min) |
| nginx / ALB | 10 min | cycle 76 |
| drain ceiling | 10 min | cycle 75 |

`apiTools.ts` L2096–2108 `generate_image` mcpFetch has **no**
`timeoutMs`. Compare L1543 / L1566 / L1596: landing-page tools
pass `timeoutMs: 25 * 60 * 1000` — already longer than nginx 600s,
so those calls can die at the proxy before the abort. They still
did not become a fifth `listen()`.

Q-014 listing does not need a timeout change (typical image gen
is well under 5 min). Raising `timeoutMs` later is still mcpFetch
to **this** PORT (ENG-1189). A-006 as HTTP would add a vendor-side
timeout behind a 5 min abort the parent already fires — ENG-1189
`fetch failed` with a number.

Hermes/OMP: one execute() promise, one timeout. AgentWeb already
special-cases long tools by `timeoutMs` on the existing hop.
Cutting-edge SDLC is that override, not a mesh.

## Queue effect

A-006 stays **discard** (new citation: `httpClient.ts` L205 default
5 min; `generate_image` does not override). Q-014 stays **ready**
(list ≠ timeout). A-017 stays park.

## Next

Cycle 78: cheapest remaining mapping. Do not un-ready Q-001 /
Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
