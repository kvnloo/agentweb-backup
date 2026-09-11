# Q-015 brief — hide always-admin MCP tools from Hermes

Status: **ready** (flags + tests; no schema). Not in the first three PRs.
Does **not** unlist the customer CRUD catalogue (ENG-983).

## Problem

`ListToolsRequestSchema` (`mcpServerCore.ts` L81–83) dumps every
non-`internal` tool. There is no `isAdmin` on that handler.
`adminClientScope.ts` only runs at execute when `client_id` is passed.

Always-admin tools are therefore in every OAuth client's `tools/list`:
`freeze_user_account` (deactivate a user), `list_all_clients` (emails,
Stripe ids, payment method), `manage_user_notes`, plus a long tail of
health/lifecycle/skill-admin tools. REST 403 is not enough: the names are
a privilege oracle and they crowd Hermes context.

`post_on_account` is **not** this item (Q-004). Dual-use tools that take
optional `client_id` (`list_tasks`, `manage_leads`, …) stay listed.

## Acceptance

1. External `getToolDefinitions()` omits at least:
   `freeze_user_account`, `list_all_clients`, `manage_user_notes`.
2. External `execute` of those three with `externalMcp === true` is
   refused (`internalOnly`), not 403-after-the-model-already-called.
3. In-app Emma admin skill still has them (`ADMIN_SKILL_TOOL_NAMES` in
   `agentModeService.ts` L199). MCP flags do not remove emma-registry
   tools.
4. `manage_*` customer CRUD remains listed until ENG-983.
5. No new Dynamo table; no ListTools user-DB lookup in this slice.

## First slice

On those three `apiTools.ts` registrations: `internal: true` and
`internalOnly: true`. Pin in `security.mcpServer.test.ts`.

Why not a list-time `adminOnly` filter: ListTools currently has no user
record. That would be a follow-up if Harsha needs freeze-from-Hermes.
Until then, partner-portal + in-app Emma are the admin consoles.

## Later (not this PR)

`adminOnly` on the rest of the admin-only block (client health, PR
digest, skill management, lifecycle drip, landing-page discovery). Same
flags, more names. Optional: ListTools looks up `isAdmin` and shows
them to admin OAuth clients only.

## Out of scope

ENG-983. Q-004 `post_on_account`. Q-014 un-hiding `generate_image`.

## Collision

ENG-983 unlisting `manage_*` — do not hide those here. ENG-1596
client-scope is execute-only; don't restack it.

## Rollback

Remove the flags on the three tools.
