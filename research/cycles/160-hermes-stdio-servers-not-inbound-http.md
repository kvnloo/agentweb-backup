# Cycle 160 — Hermes loop is still an MCP client; two opt-in stdio servers already exist

**Date:** 2026-09-12T00:42:00Z
**Question:** Cycle 159: Hermes MCP client is ~24 in-process files.
Is `mcp_tool_server_run.py` still connect-only (cycle 89), or did
`v2026.9.11` add inbound HTTP `/mcp`?

**Answer:** The **loop** is still a client. `mcp_tool_server_run.py`
is still connect → serve-the-remote-session → park/recycle. The
`/mcp` string in that file is a **slash-command refresh**, not a
listen(). Cycle 89 overstated the **repo**: two opt-in **stdio**
MCP servers already exist (`hermes mcp serve`,
`hermes-tools` for Codex). Neither is an HTTP nanoservice of the
agent loop.

## Evidence

Live `tools/mcp_tool_server_run.py` (main, 418 lines) L1–4 still:

> Lifecycle of `MCPServerTask`: the long-lived `run` state machine
> (connect -> serve -> reconnect/park/recycle)…

`run()` L194–206: `run_transport = self._run_http if self._is_http()
else self._run_stdio` — outbound to a **configured** server. `_park`
L136: “OAuth recovery, **manual /mcp refresh**” sets
`_reconnect_event`. That is a client reconnect, not FastAPI `/mcp`.

`hermes_cli/web_routers/mcp.py` is a **dashboard** for adding
outbound servers. OAuth callback is `/api/mcp/oauth/callback/...`,
not `tools/list`.

Two stdio servers cycle 89 did not name (files present since
2026-09-02/03, before that scan):

1. **`mcp_serve.py`** — `hermes mcp serve`. Docstring: expose
   **messaging conversations** as MCP tools. `run_mcp_server`
   L721 `await server.run_stdio_async()`. `_TOOL_NAMES` L685–688:
   `conversations_list`, `messages_read`, `messages_send`, …
   **No** `image_generate`. CLI: `hermes_cli/subcommands/mcp.py`
   L14–18 “run Hermes as an MCP server” / “expose Hermes
   conversations over MCP.”

2. **`agent/transports/hermes_tools_mcp_server.py`** — Codex
   subprocess. Docstring L1–5: “Hermes-tools-as-MCP server…
   exposed over **stdio** MCP; codex registers it via
   `~/.codex/config.toml [mcp_servers.hermes-tools]`.”
   `EXPOSED_TOOLS` includes `image_generate` (L45).
   `main()` L139 `server.run()` “defaults to stdio transport.”

## What this is not

Not a product patch. Do not rewrite `HERMES_MCP_OAUTH.md`.
Q-001 still smokes Hermes **as client** against AgentWeb’s
existing `/mcp`.

Not A-006. Hermes serving tools to Codex is a **stdio subprocess
with a curated tuple**, not HTTP-splitting `agentModeService.ts`.
AgentWeb already is the HTTP MCP server Q-014 lists on.

Not a Q-014 / Q-001 / Q-003 status change.

## Relation to A-002 / A-007 / A-008

A-007 is still five mcpFetch tools in one file. Hermes’s
`EXPOSED_TOOLS` is a allowlist over one `handle_function_call`
(cycle 161). Copy the allowlist shape, not a mesh.

## Next cycle candidate

`hermes_tools_mcp_server.py` L90 `handle_function_call(tool_name,
kwargs)` — in-process leaf, stdio bus. Is that the Q-014 analog
(list `image_generate` without an HTTP hop behind the server)?
File-level on the live blob vs AgentWeb `emmaApi.ts` mcpFetch.
