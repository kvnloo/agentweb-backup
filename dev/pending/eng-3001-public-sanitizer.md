## ENG-3001: Close recursive public MCP sanitizer gaps (2026-11-14)

Public MCP results now traverse structured content, envelope siblings, arrays and JSON-encoded text through one sanitizer. Over-budget nesting becomes null instead of returning unvisited data. The nesting budget is 128 object/array levels (encoded text spends none), so stored data of ordinary depth survives the MCP envelope; a non-syntax JSON parser failure also returns null. Session/run/request exceptions are scoped by tool purpose; admin/internal/delegated output remains unchanged. Regression fixtures exercise the registered CallTool boundary for API-key and OAuth callers.

The related MCP registry suite exposed six existing Smartlead registrations missing deterministic classification; reproduced on unmodified main, then classified their read/stop handlers without changing enforcement.
