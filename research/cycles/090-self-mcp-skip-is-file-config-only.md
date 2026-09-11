# Cycle 90 — Self-MCP skip is file-config only

**UTC:** 2026-09-11T21:55:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.
**New item:** A-018 (park).

## Question

Cycle 29 / 89: `mcpClientService.ts` L420–432 skips self
`"agentweb-tools"`. Did anyone re-enable that self-client, or is the
skip the whole door?

## Finding

**File-config skip still holds. Nobody re-enabled it. The skip is not
the whole door.** `initialize()` filters `isInternal` only on
`Object.entries(internalMcpServers)`. The Dynamo `mcp_servers` path
connects anyway. Tests *use* that second path. Admin add recycles the
worker onto it. A fifth `listen()` is not the missing filter.

### File config is still skipped (cycle 29 still true)

`mcp_config.ts` L3–10 still lists `"agentweb-tools"` at
`http://localhost:${PORT||3001}/mcp` with `isInternal: true`.
`initialize()` L419–432 still filters
`!('isInternal' in config && config.isInternal)` and logs
“skipping self-connection” when the remainder is empty. GitHub in the
same object has no `isInternal` and still connects. Q-014 does not
touch this file.

`backend/src/registry/mcp_config.json` is a **dead duplicate**
(zero importers). Its URL is `${BACKEND_URL}/mcp/server` — a different
path than the TypeScript config. Do not “fix” the skip by loading it.

### DB path does not copy the filter

`initialize()` L435–450 loads `settingsService.getSetting("mcp_servers")`
and `safeConnectToServer`s every named entry. The only skip is
`this.clients.has(server.name)` (L445–447). Skipped file servers never
enter `this.clients` (that map is set at `connectToServer` L1611), so a
DB row named `agentweb-tools` **would connect**.

`safeConnectToServer` L473–476 *does* honor `excludeFromAgent`
(Higgsfield). That is a different flag. `isInternal` on this path is
**identity**, not a skip: L1612 / L1637–1642 inject `userId` /
`sessionId` / `llmModel` into CallTool args.

Characterization tests document the hole:
`mcp.mcpClientService.test.ts` L1041–1048 — “Use DB config path since
internal servers with isInternal:true are now skipped” — then connects
`isInternal: true`. L657–668 is the same door for context injection.

### Admin UI can still loopback without the flag

`app.ts` L437: `POST /api/admin/mcp-servers` is `authenticateToken` +
`isAdmin`. `mcpServers.ts` L87–90 `isValidUrl` allows any `http:` /
`https:` (localhost included). L148 / L198 persist `isInternal` when
sent. Partner `McpServersTab.tsx` has **no** `isInternal` Switch
(default `false` at L206 / L547). The visible switch is
`excludeFromAgent` (L893–904). The URL field can still be
`http://localhost:3001/mcp`. That row is `isInternal: false` and
still loads.

`syncMcpAndRecycleWorker` (`mcpServers.ts` L64–82) then:
parent `refreshMcpTools` → `mcpClientService.refresh()` L1879–1882
(`shutdown` + `initialize`, same file-only filter); worker
`shutdown()` so the fork’s `generateMarketingResponseWorker.ts` L36
`agentModeService.initialize()` reloads DB servers. `IS_MCP_SERVER`
(`agentModeService.ts` L1593–1597) is still unused in-repo — both
processes load clients (cycle 45).

Admin **Discover** is a third face that never calls `initialize()`:
`mcpServers.ts` L443–465 `new McpClientService()` → `createTransport`
→ SDK `listTools`. No `isInternal` filter. Same `isValidUrl`. A-018’s
loopback reject on POST covers this; wrapping CallTool does not.

Q-014 listing `generate_image` makes a loopback DB server more
interesting (prefixed copies of the same tools). It does not require
one. Do not delay Q-014 to close this admin door.

### `getSessionClient` is not a fourth door

`createSessionClient` L843–845 throws `Server config not found` unless
`serverConfigs` has the name. File-config skip never calls
`safeConnectToServer`, so it never `serverConfigs.set` (only L479).
Tests that still pass `'agentweb-tools'`
(`mcpClientService.browserPoolReclaim.test.ts` L89) **stuff**
`serverConfigs`. Production cannot reach that without the DB loader.

### Why this is not a nanoservice

The team already rejected self-MCP as circular (cycle 29 comment).
Closing one of two loaders is not a reason to HTTP-split
`generate_image`. Hermes stays a **client** to AgentWeb’s existing
server (cycle 89). Copy the file-config filter onto the DB loop; do not
stand up a fifth `listen()`.

## Queue effect

A-006 stays **discard** (the skip is real, incomplete). Q-014 stays
**ready**. Park **A-018**: copy L424 onto L442–450; optionally reject
loopback in `isValidUrl`. Do not re-enable `mcp_config.ts`. Do not add
an `isInternal` Switch. Do not edit `emma/tools.ts`.

## Next

Cycle 91: cheapest remaining mapping. Candidate: file-config
`github` (no `isInternal`) is the only remaining `mcp_config.ts`
connect — confirm no other in-repo loader still points at
`/mcp`. Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
