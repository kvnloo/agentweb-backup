## ENG-2867: MCP tools for own CRM lead-list export + export history (2026-11-08)

Added `export_lead_list` (tools:execute) and `list_lead_list_exports` (readOnly) MCP tools wrapping the existing JWT export routes via runtime identity; no client_id override, list_id path-encoded.
