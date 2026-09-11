# Cycle 029 — Self-MCP `agentweb-tools` is already skipped as circular

UTC: 2026-09-11T19:15Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **Collision** `imageGeneration|apiTools|loops/core|mcpClientService|mcp_config`
   on 20 open `AgentWebPro/agentweb` PRs: **empty.**

2. **AgentWeb is already an MCP *client and server*.** Hermes is client-only
   (`mcp_tool.py`). Emma’s outbound client is `mcp/client/mcpClientService.ts`
   (stdio / SSE / streamable-http, L1–4; `StdioClientTransport` L1429 for
   foreign servers like GitHub). Higgsfield video is `excludeFromAgent`
   (`videoGeneration.ts` L28–30, client L473–475) — a real MCP nanoservice
   for a *vendor*, not for `generate_image`.

3. **Self-composition via MCP was tried and skipped.** `mcp_config.ts` L3–10
   still lists `"agentweb-tools"` at `http://localhost:${PORT}/mcp`.
   `initialize()` L420–432 **filters `isInternal`**: “they connect back to
   ourselves and create a circular dependency. Internal tools are registered
   directly via the ToolRegistry.” That is A-006 in the tree: wrapping Emma
   tools as an HTTP MCP mesh to ourselves loops. Q-014 still only lists
   `generate_image` on the *server* face for Hermes; it does not re-enable
   this self-client.

## DISCARD / rank

No rank change. A-006 stays discard with this skip comment as evidence.
Product READY unchanged.

## Mapping evidence

`COMPOSITION.md` self-MCP skip. Dual MCP role vs Hermes.

## Next

Cycle 30: collision-only. Unsubscribe after `stop_after` (2026-09-12T06:00Z).
