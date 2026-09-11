# Cycle 92 — `mcp:inspector` is SSE against a path that does not exist

**UTC:** 2026-09-11T21:58:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.
**Do not rewrite:** `HERMES_MCP_OAUTH.md` (Q-001).

## Question

Cycle 91: live face is `/mcp`; `package.json` `mcp:inspector` still
points at `/mcp/server`. Is that script at least the right
**transport** for the live server, or would fixing the path still
fail?

## Finding

**Wrong path and wrong transport.** `mcp:inspector` is
`--transport sse --server-url http://localhost:3001/mcp/server`.
Live initialize is **POST `/mcp` Streamable HTTP**. GET `/mcp` is
SSE only **after** `mcp-session-id` exists (cycle 72). Pointing
SSE at `/mcp` without a session is 400, not a nanoservice.

### Citations

`backend/package.json` L21:
`npx @modelcontextprotocol/inspector --transport sse --server-url http://localhost:3001/mcp/server`.

`mcpServer.ts` L298: `app.post("/mcp", …)` is initialize + JSON-RPC
(Streamable HTTP). L508–531 GET `/mcp` “opens SSE stream for
server-to-client notifications” and L512–515 **400 Missing session ID**
if that header is absent. There is no GET `/mcp/server`.

The abandoned self-client (`mcp_config.ts` L4–8) was already
`transport: "streamable-http"` at `/mcp` — the correct pair — and is
skipped (cycle 90). Inspector did not follow that pair.

Q-001: `HERMES_MCP_OAUTH.md` L21 is
`hermes mcp add emma --url https://api.agentweb.pro/mcp --auth oauth`.
That is the live POST face. Hermes may speak SSE as a *client*
option (cycle 89 `mcp_tool.py` L1–10) but AgentWeb’s Emma URL is
Streamable HTTP. Do not rewrite the runbook to match the inspector.

### Why this is not a nanoservice

A fifth `listen()` would not make `npm run mcp:inspector` work.
Fixing the script (streamable-http + `/mcp`) is local-dev hygiene
after Q-014, not an extract. Drain still has to close GET `/mcp`
SSE (cycle 72) for real Hermes sessions that opened the notification
stream — that is `mcpShutdown` after CallTool wait, still in-process.

## Queue effect

A-006 stays **discard**. A-018 stays **park**. Q-001 stays **ready**
(runbook ≠ inspector). Q-014 stays **ready**. No new A-item for a
package.json script.

## Next

Cycle 93: cheapest remaining. Candidate: OMP 0.85.1 still current,
or whether `mcpShutdown` is still unused by `runDrain` (cycle 69)
now that inspector cannot open the GET. Do not un-ready Q-001 /
Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
