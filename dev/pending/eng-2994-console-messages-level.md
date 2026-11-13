## ENG-2994: Relax over-strict `level` on playwright_browser_console_messages (2026-11-13)

- `utils/mcpToolSchemaSanitizer.ts` drops `level` from the ingested schema `required` list; Playwright MCP defaults it server-side. Removes pre-execution "Missing required argument level" rejects (4/17 calls). Rollback: revert the one-line map entry.
