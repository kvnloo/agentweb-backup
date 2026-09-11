# Cycle 137 — the other repo’s IA is a typed list in this backend, not an HTTP nanoservice

**UTC:** 2026-09-12T00:00:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 136: customer-portal is a fifth repo. Does this tree still
own that repo’s information architecture as data, and is that
composition a nanoservice or an in-process list? File-level.

## Finding

**In-process list, one GET. Not a fifth `listen()`.**

`backend/src/services/customerPortalPages.ts` L7–11 is
`CustomerPortalPage { path, label, description? }`. L28–124
is `CUSTOMER_PORTAL_PAGES`. Header L15–18 tells the author to
keep it aligned with `customer-portal/src/App.tsx` and
`Layout.tsx` — paths that cycle 136 showed are **not in this
tree**. Drift is a two-repo comment, not a process boundary.

Callers in this repo:

| Site | What it does |
|---|---|
| `getCustomerPortalPages()` L129–130 | returns the same array |
| `subscription.ts` L322–325 | `GET /customer-portal-pages` JSON `{ pages }` after `authenticateToken` |
| `subscriptionService.getAllAvailablePages()` L480–484 | default pages + mapped paths (entitlement) |
| `marketingActionContract.ts` L37–38 / L99 | deep links treated as opaque strings |

The HTTP hop exists because the UI origin is another repo
(cycle 136). The **policy** is the typed constant. Extracting
a pages nanoservice would split a 160-line array from
subscription entitlement (`subscriptionService.ts`) and still
leave Q-014’s image hop on the parent MCP server.

This is the modular-monolith shape Hermes/OMP already use:
a catalog in-process, HTTP only at the product edge. Do not
add A-021. Do not vendor `/mcp` instead of Q-014.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Do not add A-021. Q-001 stays **ready**. Q-014 stays
**ready**.

## Next

Cycle 138: cheapest remaining. Candidate: `growth-chat/` is
the other gitignored sibling (`.gitignore` L122). Is it named
in this Actions graph, or another missing reporter like
agent-engine? File-level.
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
