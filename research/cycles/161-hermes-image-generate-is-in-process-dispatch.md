# Cycle 161 — Hermes `image_generate` on stdio MCP is in-process `handle_function_call`

**Date:** 2026-09-12T00:44:00Z
**Question:** Cycle 160: Codex-facing `hermes-tools` MCP lists
`image_generate`. Does that hop HTTP to a second process, or
dispatch the same in-process leaf AgentWeb’s Q-014 should list?

**Answer:** In-process. `_make_handler` calls
`model_tools.handle_function_call` in the same Python process.
Stdio is the bus. AgentWeb’s listed `generate_image` still
mcpFetchs localhost (`emmaApi.ts`). Q-014 is listing, not adding
that hop. Hermes already listed the leaf without a hop.

## Evidence

Live `agent/transports/hermes_tools_mcp_server.py` (150 lines):

```38:45:  (live NousResearch/hermes-agent main)
# Each name MUST match a registered Hermes tool ``model_tools.handle_function_call()`` can dispatch.
EXPOSED_TOOLS: tuple[str, ...] = (
    "web_search", "web_extract",
    ...
    "vision_analyze", "image_generate", "skill_view", "skills_list", "text_to_speech",
```

Dispatch:

```84:90:  (same file)
        def _dispatch(**kwargs: Any) -> str:
            try:
                # Drop None so unset optionals aren't forwarded to the handler.
                return handle_function_call(tool_name, {k: v for k, v in kwargs.items() if v is not None})
```

Registration loops `EXPOSED_TOOLS`, skips names missing from
`get_tool_definitions` (L102–108). One registry, one handler,
stdio `server.run()` (L139).

AgentWeb Q-014 (still **ready**, in flight #2): drop
`internal: true` on MCP `generate_image` (`apiTools.ts` L2077).
The listed face already mcpFetchs `POST /api/emma/generate-image`
(`emmaApi.ts`). That hop is the **adapter**, not the leaf
(cycle 25/36). Hermes’s Codex face has no equivalent hop:
Codex stdio → same process → `handle_function_call`.

`mcp_serve.py` is a **different** catalog (conversations, 10
tools, L685–688). It does not list `image_generate`. Two MCP
**servers**, two allowlists, still one loop’s tools. Hermes:
curated tuples. AgentWeb: `internal` flags + four registries
(cycle 139).

## What this is not

Not a product patch. Do not copy `EXPOSED_TOOLS` into
`apiTools.ts`. Q-014 stays drop `internal` on one tool.
Do not HTTP-split `generateImage` to “match” Hermes — Hermes
did the opposite.

Not A-006. A fifth `listen()` behind `/mcp` would be the hop
Hermes refused for Codex.

Not a Q-014 / Q-001 / Q-003 status change.

## Relation to A-002 / A-007 / A-008

A-007’s first file (`tools/infrastructure.ts`) is the
`EXPOSED_TOOLS` analog: a named list over in-process mcpFetch.
A-008 still `git mv` + path shim. Do not add A-021.

## Next cycle candidate

Does AgentWeb MCP `generate_image` schema (snake_case, no
`confirm`, cycle 39) match Hermes `image_generate` JSON schema
from `get_tool_definitions`? File-level: live Hermes tool spec
vs `apiTools.ts` L2075. A-011 already parks unifying Emma vs
MCP — do not add a Hermes-schema unify item.
