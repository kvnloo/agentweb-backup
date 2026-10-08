## ENG-1459: C3b transport-remnant audit (2026-08-22)

After C3a routed AgentMode text/tool calls through `callLLM` and the shared gateway, the only
remaining unreachable Vertex Claude adapter artifacts were `vertex_client`,
`vertex_client_promise`, and `convertContentToAnthropicBlocks`. They had no callers, and the
converter's former tests covered only that retired transport. They were deleted with an AST-backed
regression guard. The direct Gemini SDK site retained in `performDataAnalysis` is the documented
Gemini code-execution/file-analysis exception, not a text/chat transport. Evidence: guard 21/21,
all `agentMode*` suites green, and backend typecheck clean. Complexity delta: -171 lines overall.
