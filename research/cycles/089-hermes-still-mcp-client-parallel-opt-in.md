# Cycle 89 — Hermes is still an MCP client; parallel is opt-in

**UTC:** 2026-09-11T21:50:00Z
**Kind:** comparison
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.
**Do not rewrite:** `HERMES_MCP_OAUTH.md` (Q-001).

## Question

Cycle 88: OMP unpublished a server split. Cycle 28/56: Hermes
`mcp_tool.py` is client-only and skipped by discover. Live main
now has `mcp_tool_server_run.py` — did Hermes become an MCP
**server** (so AgentWeb should HTTP-split to match), or is that
still remote-client lifecycle? And who bounds parallel
`generate_image` CallTools (cycle 83)?

## Finding

**Still client-only. `mcp_tool_server_run.py` is the long-lived
Task that *connects to* a configured server, not Hermes serving
tools. Parallel MCP is opt-in (`supports_parallel_tool_calls`,
default false). AgentWeb’s OAuth runbook does not set it. Q-014
lists; Hermes serializes unless Kevin opts in. A fifth
`listen()` would not add that flag.**

### Live `NousResearch/hermes-agent` main (this scan)

`tools/registry.py` `discover_builtin_tools` L92 still skips
`mcp_tool.py` (with `__init__.py` / `registry.py`). MCP is not a
self-registering builtin; it is a **client loader**.

`tools/mcp_tool.py` L1–10: “MCP **client**: connects to the
`mcp_servers` configured in `~/.hermes/config.yaml` (stdio,
Streamable HTTP or SSE).” One background loop; `MCPServerTask`
per remote server.

`tools/mcp_tool_server_run.py` L1–4: lifecycle of that Task
(`connect → serve → reconnect/park/recycle`). “Serve” here
means keep the **remote** session alive, not expose Hermes tools
over `/mcp`.

### Parallel is a client policy, default off

`mcp_tool_discovery.py` L236–241: registration reads
`srv_cfg.get("supports_parallel_tool_calls", False)` into
`_parallel_safe_servers`.
`is_mcp_tool_parallel_safe` L426–433: only MCP-prefixed tools
whose **server** opted in.

`backend/docs/HERMES_MCP_OAUTH.md` has **zero**
`supports_parallel` / `parallel_tool` hits. Q-001’s recipe does
not opt Emma in. Default Hermes host therefore **serializes**
Emma `CallTool`s. Cycle 83 still holds for Cursor/Claude or an
opted-in config — the bound is the **client**, not AgentWeb’s
Express handler.

Do not add `tryClaimSessionGeneration` on `/mcp` (cycle 80).
Do not rewrite the runbook from this cycle (Q-001: rewrite only
if smoke finds a lie). Optional later: document the flag in the
skill, not a product PR.

### Why this is not a nanoservice

Hermes composes by **being a client** to AgentWeb’s existing
MCP server (Q-014). OMP unpublished *its* experimental server
(cycle 88). AgentWeb already is the server those clients call.
HTTP-splitting `generate_image` would add a hop **behind** the
server Hermes already speaks, duplicating the leaf (cycle 36)
without giving Hermes a parallel flag it already owns.

## Queue effect

A-006 stays **discard**. Q-014 stays **ready**. Q-001 stays
**ready** (existing runbook still the smoke). Do not copy
Hermes’ `_parallel_safe_servers` into AgentWeb.

## Next

Cycle 90: cheapest remaining mapping. Candidate: AgentWeb
`mcpClientService.ts` L420–432 still skips self
`"agentweb-tools"` (cycle 29) — confirm no one re-enabled it.
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
