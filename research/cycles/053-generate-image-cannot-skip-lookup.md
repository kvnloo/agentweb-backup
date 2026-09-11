# Cycle 53 — generate_image MCP cannot skip lookupUser via ENG-1596

**UTC:** 2026-09-11T20:28:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006. **Do not merge:** A-015.

## Question

Cycle 50: `mcpFetch` skips `lookupUser` when `context.overrideToken` is set
(ENG-1596). Cycle 51: that skip plus the Emma meter would uncapped-spend
for `anon_*`. Can MCP `generate_image` ever take that skip?

## Finding

**No. The image tool cannot mint or forward `overrideToken`.**

### 1. Execute uses `ctx()`, which does not carry `overrideToken`

`apiTools.ts` L2096–2098:

```
execute: async (args, context) => {
  const data = await mcpFetch({
    method: 'POST', path: '/api/emma/generate-image', context: ctx(context),
```

`toolHelpers.ts` L10–22 `ctx()` returns only `userId`, `agentUserId`,
`isDelegatedAccess`, `sessionId`. **No `overrideToken`.** Even if the
dispatcher attached one, `ctx()` would drop it.

Schema L2081–2093 has no `client_id`.

### 2. `resolveClientScopedContext` is admin-only and not on this tool

`adminClientScope.ts` L1–8 / L48–116: ENG-1596 mints a 300s delegate
token after `getUserById(callerId)` proves `caller.isAdmin` and the
target is a real customer. That **is** a user-row lookup — of the admin
and the target — then `mcpFetch` uses `overrideToken` and skips the
anon-shaped `lookupUser`.

Call sites in `apiTools.ts`: `list_tasks` L335, `list_scheduled_chats`
L513, `list_lead_lists` L901, `manage_leads` L1000, `search_leads`
L1084, `list_connected_accounts` L1485, `get_account_status` L3592.
**Not** `generate_image`.

An anonymous caller cannot pass this gate: no admin row, and
`generate_image` never calls it.

### 3. The $2 anon cap is a different face

Chatbot stays on the parent (`chatbotService.ts` L5461 `executeTool`)
after `chatbot.ts` L155–168 `checkTokenUsage(userId)`. ishare
`generateSharedResponse` (`agentModeController.ts` L10326–10332) gates
on the **share owner**. `createSessionWithPlan` L13664 mints `anon_*`
for public plan demos — that is the ENG-1163 $2 ChatSessions cap.

MCP `generate_image` is none of those. It is `ctx()` → `lookupUser`.

| Face | Identity / spend |
|---|---|
| MCP `generate_image` | `ctx()` → `lookupUser` (must be an `AW-Users` row) |
| Emma API if the hop happened | `requireEmmaTokenBudget` allow-lists `anon_*` (cycle 51) |
| Chatbot / ishare / `createSessionWithPlan` | in-process `executeTool`; `$2` cap is **intentional** for `anon_*` |

A-006 as a fifth HTTP image process would have to pick one of these
three policies or reimplement all three. Hermes has one host identity
check. A-007’s `tools/infrastructure.ts` must keep `ctx(context)`, not
copy `resolveClientScopedContext` from `list_tasks`.

## Why this is not Q-014 work

Q-014 drops `internal: true`. Do not add `client_id`. Do not add
`overrideToken`. Do not add `requiresUserAccount`. Authenticated Hermes
still hits `lookupUser` on a real user.

## Collision

Skipped (cycle 52 just cleared these files). Mapping is cheaper.

## Next

Cycle 54: cheapest remaining mapping **or** collision if AgentWebPro
lands on `apiTools.ts`. Do not un-ready Q-001 / Q-014 / Q-003.
Unsubscribe after `2026-09-12T06:00:00Z`.
