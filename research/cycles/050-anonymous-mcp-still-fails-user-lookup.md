# Cycle 50 — anonymous MCP execute still fails user lookup (defense in depth)

**UTC:** 2026-09-11T20:25:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not merge:** A-015 (park: do not add `generate_image` to `ANONYMOUS_TOOLS`)

## Question

If A-015 were violated — `generate_image` added to `ANONYMOUS_TOOLS` so
`CallTool` ran past the transport allowlist — would mcpFetch still reach
`generateImage` / the leaf? Cycle 49 proved the allowlist is the first spend
door. This cycle asks whether the **HTTP hop** is a second door.

## Finding

**The hop never leaves the MCP process. `lookupUser` throws before a JWT is
minted. The visitor would see `User not found`, not a generated image.**

Anonymous sessions mint `userId = \`anon_${sessionId}\``
(`anonymousTransport.ts` L114–117). The handler then calls `mcpFetch`.

### Door 2 — `lookupUser` (before HTTP)

`backend/src/mcp/server/httpClient.ts`:

- L57–66 `lookupUser`: `userDb.getUserById` → throw `User not found: ${userId}`
- L164–173 `mcpFetch`: unless `overrideToken` (ENG-1596 admin client-scope),
  it **always** `await lookupUser(userId)` **then** `generateSelfCallToken`

`anon_*` is not a Dynamo user. No self-call JWT, no `POST /api/emma/generate-image`,
no leaf, no vendor.

### ENG-822 does not convert this into a sign-in message

`apiTools.ts` `generate_image` (L2076) has **no** `requiresUserAccount`
(grep empty under that file). `registry.ts` L136 only refuses when that
flag is set. So a leaked `CallTool` would run the handler, hit door 2, and
surface the exact string ENG-822 was written to hide
(`registry.anonymousUserScopedTools.test.ts` L1–9: Dev-AW-LoopEvents,
`errorMessage = "User not found"`).

That is a **UX** hole if A-015 is violated, not a spend hole. Do not add
`requiresUserAccount` inside Q-014 as a substitute for the empty allowlist
(cycle 49). The flag is for account-scoped reads (`read_brand_guidelines`);
image gen’s spend door is the transport + this lookup.

### What this cycle does **not** claim

`requireEmmaTokenBudget` is **not** a third fail on this path: the request
never reaches `emmaApi.ts`. Cycle 51 maps what that middleware actually
does for `anon_*`.

## Why A-006 as a fifth HTTP service is worse

A nanoservice wrapping `generateImage` that skipped this lookup (or minted
a token without a user row) would bypass the only MCP-hop spend door that
survives an A-015 leak. Copying `emmaApi` “because it is metered” is not
the same copy — see cycle 51. Modular monolith: one `lookupUser` in
`httpClient.ts`. Microsoft 2026: modular-monolith first.

## Hermes / Oh My Pi

Hermes `registry.py` and OMP `pi-ai` have no user table. Both assume the
**host** owns identity. AgentWeb’s host **is** this backend process.
Splitting the leaf into HTTP does not move identity — it duplicates or
drops `lookupUser`.

## Collision

Skipped. Mapping is cheaper: `anonymousTransport.ts` L114–117,
`httpClient.ts` L57–66 / L169, `registry.ts` L129–137, `apiTools.ts` L2076.

## Next

Cycle 51: what `requireEmmaTokenBudget` / `checkTokenUsage` actually do for
`anon_*` (it is not a fail). Do not un-ready Q-001/Q-014/Q-003.
Product PRs stay on their branches (`#2` Q-014+Q-004, `#3` A-002).
