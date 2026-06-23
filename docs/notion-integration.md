## Notion Integration (Sprint Tasks)

A Notion MCP server is configured via `.mcp.json` in the repo root. Use the `mcp__notion__*` tools to query the **"Sprint Tasks - Argusoft"** Notion database for dev items.

**When the user asks to pull dev items, check sprint tasks, or reference Notion tickets:**
1. Use `mcp__notion__API-query-data-source` with data source ID `2bf09247-c951-812a-bd0a-000bd4c05bbf`
2. Filter by status (e.g., `{"property": "Status", "status": {"equals": "To-do"}}`)
3. Pull task details including title, status, assignee, priority, and description
4. Present tasks in a clear summary format

**Key IDs:**
- Database ID: `2bf09247-c951-8122-a327-ee39ef7a6ec7` (for search/retrieve)
- Data Source ID: `2bf09247-c951-812a-bd0a-000bd4c05bbf` (for queries — use this with `API-query-data-source`)

**Database properties:** Name (title), Status (To-do/Not started/Blocked/In progress/In Review/Done), Priority Level (High/Medium/Low), Sprint, Owner (people), Tags, Sprint Points, Due Date, Blocking/Blocked by (relations), Parent item/Sub-item (relations), Coding Model (select — controls which AI agent runs the task in cloud-dev)

**Coding Model property:** Add a **Select** property named exactly `Coding Model` to the database. Options:
- *(empty / not set)* — default, uses **Claude Opus 4.8** via AWS Bedrock
- `gpt-5.5` — uses **GPT-5.5** via Azure OpenAI (Codex CLI)

Leave the property unset on most tasks. Set it to `gpt-5.5` on a task to have the cloud-dev instance use Codex instead of Claude Code for that run.

**Setup:** The `.mcp.json` file is gitignored since it contains the API token. A template is provided at `.mcp.json.example`. See `dev.md` entry "Notion MCP Integration for Sprint Task Management" for full configuration steps.

**Auto-setup:** If Notion MCP tools are not available or return auth errors:
1. Check if `.mcp.json` exists — if not, copy from `.mcp.json.example`
2. Check if it still has the `<YOUR_NOTION_TOKEN>` placeholder
3. If placeholder found, ask the user for their Notion API token (created at https://www.notion.so/profile/integrations)
4. Replace the placeholder in `.mcp.json` with the real token
5. Tell the user to restart Claude Code to load the MCP server
