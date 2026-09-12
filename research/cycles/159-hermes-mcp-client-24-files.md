# Cycle 159 — Hermes MCP client is now ~24 in-process files; still not a server

**Date:** 2026-09-12T00:38:00Z
**Question:** Cycle 158 next: refresh Oh My Pi / Hermes vs
`COMPARISON.md` 2026-09-11. Did either become an HTTP mesh, or
did the in-process split deepen?

**Answer:** Oh My Pi is still `@earendil-works/pi-ai` **v0.85.1**
(2026-09-05). Hermes tagged **v2026.9.11** (2026-09-11T19:20Z)
and main moved after cycle 89. The MCP surface is now **~24
client modules** in `tools/`. `discover_builtin_tools` still skips
`mcp_tool.py`. Not a fifth `listen()`.

## Evidence

Live `gh api repos/earendil-works/pi/releases/latest` this cycle:
`v0.85.1` published 2026-09-05T12:29:01Z. `packages/ai/package.json`
at that tag: `@earendil-works/pi-ai` 0.85.1 depends on
`@earendil-works/pi-telemetry` only among the workspace — same
DAG as cycle 88. Thesis unchanged.

Live `NousResearch/hermes-agent` `tools/mcp_tool.py` docstring
(main, this scan):

> MCP (Model Context Protocol) **client**: connects to the
> `mcp_servers` configured in `~/.hermes/config.yaml` (stdio,
> Streamable HTTP or SSE)… The `mcp_tool_*` siblings read that
> state back through `tools.mcp_tool` at call time (`_core`)
> and are imported directly by their callers.

`tools/registry.py` still skips the loader:

```
97:        if path.name in {"__init__.py", "registry.py", "mcp_tool.py"}:
```

Cycle 89 cited that skip at **L92**. The set is the same; the
line moved. MCP is still not a self-registering builtin.

`gh api .../contents/tools?ref=main` this cycle — MCP-named
files (bytes):

| File | Bytes |
|---|---|
| `mcp_tool.py` | 39032 |
| `mcp_tool_handlers.py` | 34211 |
| `mcp_tool_transport.py` | 30044 |
| `mcp_tool_discovery.py` | 28311 |
| `mcp_tool_registration.py` | 27536 |
| `mcp_tool_server_run.py` | 24347 |
| `mcp_oauth.py` | 54006 |
| + 17 more (`mcp_tool_*`, `mcp_oauth_*`, `mcp_death_supervisor.py`, `mcp_schema_cache.py`, `setup_mcp_tool.py`) | |

Cycle 89 named three (`mcp_tool.py`, `mcp_tool_server_run.py`,
`mcp_tool_discovery.py`). Hermes decomposed the **client** the
way OMP decomposes packages: more files, one process, one
registry. AgentWeb’s A-007 (`apiTools.ts` →
`tools/infrastructure.ts`) is that shape. A-006 (HTTP per tool)
is the opposite of what Hermes just did.

Hermes latest tag `v2026.9.11` does not turn AgentWeb into a
mesh. Q-001 is still the OAuth smoke against this client.

## What this is not

Not a product patch. Do not copy 24 Hermes files into
`backend/src/mcp/`. A-007 is still five mcpFetch tools.

Not A-006. Hermes grew client files, not servers.

Not a Q-014 / Q-001 / Q-003 status change.

## Relation to A-002 / A-007 / A-008

A-007 first file is still `tools/infrastructure.ts`. Hermes’s
split is evidence that the catalog decomposes in-process.
A-002 still does not cover `chatbotService.ts` (cycle 140).

## Next cycle candidate

Does `mcp_tool_server_run.py` on this main still connect-only
(cycle 89 L1–4), or did v2026.9.11 add an inbound `/mcp`?
File-level on the live blob. Do not rewrite
`HERMES_MCP_OAUTH.md`.
