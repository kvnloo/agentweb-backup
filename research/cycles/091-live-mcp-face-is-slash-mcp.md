# Cycle 91 — Live MCP face is `/mcp`; `/mcp/server` is stale

**UTC:** 2026-09-11T22:00:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.
**Do not rewrite:** `HERMES_MCP_OAUTH.md` (Q-001).

## Question

Cycle 90: file-config `github` (no `isInternal`) is the only remaining
`mcp_config.ts` connect. Does any in-repo loader still point at
`/mcp/server` (the dead JSON path), and is that a second live face
Hermes should call?

## Finding

**One live HTTP face: `POST|GET|DELETE /mcp`.** There is **no**
Express `/mcp/server` route. `github` in `mcp_config.ts` is stdio to
a vendor, not a self-loop. Stale `/mcp/server` strings are docs and
the inspector script. Q-001’s runbook already uses `/mcp`. Do not
HTTP-split to “fix” a path that shipped as a rename in 2026-03.

### What actually listens

`mcpServer.ts` L298 / L509 / L535 mount `/mcp` only. `app.ts` L204
`setupMcpServer(app)` is that set. OAuth protected-resource metadata
is `${baseUrl}/mcp` (`oauthRoutes.ts` L81; test L153).

`mcp_config.ts` remaining connect after the `isInternal` skip is
`"github"` (L11–18, stdio `npx @modelcontextprotocol/server-github`).
That is an outbound vendor client, the Hermes shape (cycle 89), not
Emma calling Emma.

### Stale `/mcp/server` (not a second listen)

| Location | What it is |
|---|---|
| `backend/src/registry/mcp_config.json` | Unreferenced; `${BACKEND_URL}/mcp/server` (cycle 90) |
| `backend/package.json` L21 `mcp:inspector` | SSE inspector at `http://localhost:3001/mcp/server` |
| `backend/docs/AGENT_API.md` L129 | OAuth step 4 still says `/mcp/server` |
| `dev.md` L5434 | Worker “connects to internal MCP at `/mcp/server`” |

Same file `AGENT_API.md` L36 already shows Claude at
`https://api.agentweb.pro/mcp`. `user-release.ts` L4753–4754 (2026-03-05)
is the rename receipt: `/mcp/server` → `/mcp`, “all documentation
updated.” L129 and `mcp:inspector` were not.

`HERMES_MCP_OAUTH.md` L21 is `https://api.agentweb.pro/mcp`. Do not
rewrite the runbook. Smoke that hits `/mcp/server` would be following
AGENT_API step 4 or `npm run mcp:inspector`, not Q-001.

`scripts/test-mcp-session-isolation.ts` L27 still
`getSessionClient('agentweb-tools', …)` after `initialize()`. After the
file skip that throws L843. Dead script, not a production loader.

### Why this is not a nanoservice

The composition bus Hermes already speaks is `/mcp` on this process
(Q-014 lists there). A fifth `listen()` would not revive `/mcp/server`.
Fixing the inspector script / AGENT_API L129 is docs hygiene after
Q-014, not an extract.

## Queue effect

A-006 stays **discard**. A-018 stays **park** (DB loopback is still
`/mcp`, the live path). Q-001 stays **ready** (runbook URL matches
`mcpServer.ts` + OAuth metadata). Q-014 stays **ready**. Do not add a
docs PR on this timer.

## Next

Cycle 92: cheapest remaining. Candidate: `mcp:inspector` still uses
**SSE** against a Streamable HTTP server (`mcpServer.ts` GET `/mcp`
is SSE for an existing session — cycle 72). Confirm inspector
transport vs live POST. Do not un-ready Q-001 / Q-014 / Q-003.
Unsubscribe after `2026-09-12T06:00:00Z`.
