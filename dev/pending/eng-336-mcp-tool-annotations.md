## ENG-336: MCP tools/list emits readOnly/destructive/openWorld annotations (2026-10-06)

Slice 1 of ChatGPT app compliance: `McpToolRegistry.getToolDefinitions()` now attaches MCP `annotations` derived from `readOnly` (undeclared = destructive write), explicit per-tool annotations win, jest gate in `registry.toolAnnotations.test.ts`.
