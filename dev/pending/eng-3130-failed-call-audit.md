## ENG-3130: failed in-band Zoma calls leave an unmetered audit row (2026-11-17)

- A call that reports failure in-band (`success:false`, not a PREVIEW and not a write with a
  read-back verdict) is still not billed and not counted as usage, but it now writes one
  `mcp_tool_failed` row (`recordMcpToolFailed`, `services/mcpUsageEventsService.ts`) from the
  Meta/Google gateway `meter` step. Before this, such a call wrote no row at all, so a failed
  Meta or Google write attempt left no audit trail.
- The row carries tool name, platform, auth method, client and session only: no arguments and no
  error text (they can hold ad copy and ids). Same table and key shape as `mcp_tool_used`.
- It is not in `MCP_USAGE_EVENT_TYPES` and `getMcpUserUsage` counts only `mcp_tool_used`, so the
  usage report, `zoma_usage` "used" and the Stripe meter are unchanged. An audit-write error is
  logged and never fails the call.
- No database or data-plane change: no table, column or index; one new `eventType` value in the
  existing event table.
