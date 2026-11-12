## ENG-2969: MCP tool classification drift guard (2026-11-12)

Added `DETERMINISTIC_TOOLS` beside `AGENT_EXECUTION_TOOLS` in `backend/src/mcp/server/agentExecutionTools.ts` (109 + 9 = all 118 main-MCP registrations). Jest drift guard fails on any unclassified, double-classified, or stale tool name. No runtime change.
