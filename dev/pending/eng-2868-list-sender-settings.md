## ENG-2868: read-only MCP tool list_sender_settings (2026-11-07)

New readOnly MCP tool `list_sender_settings` wraps GET /api/crm/sender-emails for the calling key owner only (no args select an account) and returns an allow-listed projection: senders with usage/cap, default email sender, default LinkedIn sender, connected mailboxes. Callable with a tools:read key.
