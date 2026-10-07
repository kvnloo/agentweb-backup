## ENG-2334: MCP tool annotation policy + publication CI gate (2026-10-07)

Typed per-tool read/write policy (`mcp/server/toolAnnotationPolicy.ts`) covering all 95 public MCP tools; unclassified tools fail closed. CI gate in `mcp.publicToolInventory.test.ts` asserts annotations match policy, get_chat_history is not read-only, mutating tools are never read-only, and no banned schema fields or description phrases exist. No copy changes.
