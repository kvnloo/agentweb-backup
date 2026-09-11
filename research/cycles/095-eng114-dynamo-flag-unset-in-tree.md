# Cycle 95 — ENG-114 Dynamo store is opt-in; this tree never sets the flag

**UTC:** 2026-09-11T22:15:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.
**Do not flip:** `MCP_SESSION_STORE` (ops / table already in `create-tables.ts`).

## Question

Cycle 94: SIGTERM leaves the ENG-114 mirror so the next instance
can rehydrate. Is `MCP_SESSION_STORE=dynamo` actually selected in
this tree, or is that path still the default **memory** store
(`mcpSessionStore.ts` L205–210)?

## Finding

**This repo never sets the flag.** Factory default is `"memory"`.
`.env.example`, `.ebextensions/`, and `.github/` have **zero**
`MCP_SESSION_STORE` hits. Cycle 94’s “next box rehydrates” is
true **only if** someone set the env in AWS console — not
provable from git. Default SIGTERM still wipes the session
(cycle 93 close + in-memory store dies with the process). A fifth
`listen()` does not flip that flag.

### Citations

`createMcpSessionStore` L205–210: `"dynamo"` or anything else →
`InMemoryMcpSessionStore`. `mcpServer.ts` L399–407: with memory,
unknown local session is always a genuine miss (404 → SDK reinit).
`dev.md` L1186–1205: default memory “byte-for-byte unchanged”;
rollback is unset the env.

Table **exists** in `create-tables.ts` L1814–1816 (`AW-MCPSessions`).
That is already-shipped data-plane (Harsha). Enabling native TTL is
manual (L1810–1813). Flipping the env in prod is ops, not a product
PR, and not Q-014.

`socialPosts.ts` L16–21 still claims MinSize=MaxSize=1. Cycle 67:
do not treat that comment or DR doc MaxSize=4 as live AWS.

Live AWS console is **unverified**. Do not write “prod is memory”
as fact. Git-provable: the deploy scripts in this tree do not
select Dynamo.

### Why this is not a nanoservice

Cutting-edge 2026: modular monolith first, extract when ownership or
scale forces it. ENG-114 already extracted **metadata** behind a
flag and left the default in-process. Hermes (Q-001) already
retries initialize on 404 (cycle 91 comments in `mcpServer.ts`
L448–475). Do not HTTP-split `generate_image` to survive deploys.
Do not flip `MCP_SESSION_STORE` from this research branch.

## Queue effect

A-006 stays **discard**. Q-014 stays **ready**. Do not add “enable
Dynamo sessions” as an A-item (Harsha if it needs a prod env + TTL
confirm). A-018 unchanged.

## Next

Cycle 96: cheapest remaining. Candidate: `socialPosts.ts`
MinSize=MaxSize=1 vs `eb-deploy.sh` ASG hook (cycle 68) — is the
backend already multi-instance in scripts, contradicting that
comment? Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
