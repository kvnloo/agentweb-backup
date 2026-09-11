# Cycle 009 — MCP hide-list sketches (Q-006 / Q-015)

**When:** 2026-09-11T17:33Z  
**Focus:** File-level sketches so Q-006 and Q-015 can be coded without
guessing. Do not un-ready Q-001 / Q-014 / Q-003.

## Citations

- `mcpServerCore.ts` L77–83: `ListToolsRequestSchema` returns
  `getToolDefinitions()` with **no caller identity**. Comment "ALL clients
  now see all tools" is still stale (cycle 3). There is **no** `isAdmin`
  list-time filter today. `adminClientScope.ts` only mints a delegate token
  when `client_id` is present at *execute*.
- `registry.ts` `getToolDefinitions()` filters `internal` only.
  `internalOnly` is execute-time refuse for `externalMcp` (ENG-974).
- `apiTools.ts` L1770–1773: `edit_landing_page_file` is listed (no
  `internal`). Description tells clients to use `coding_agent`.
- Same file L1799, L1820, L1842, L1863, L1868: four other landing-page
  tools also name `coding_agent`.
- `coding_agent` is registered only on `emmaToolRegistry`
  (`emma/tools.ts` L7511). `mcpServerCore.ts` never imports that file.
  A Hermes `tools/call coding_agent` is "tool not found".
- `OPENROUTER_GATEWAY.md` L77 still claims coding agent is Anthropic SDK →
  Bedrock/Vertex. Do not restack `callLLM` (#2862) to fix the doc.
- Admin-only tools listed with no `internal` flag include at least:
  `freeze_user_account`, `list_all_clients`, `manage_user_notes`,
  `assess_client_health`, `get_pr_digest`, `list_skills` /
  `manage_skill`, `get_chat_history`, `manage_predefined_work_plan`,
  `inspect_orphaned_org_join_requests`, lifecycle/landing-page admin
  discovery. Dual-use tools (`list_tasks` + optional `client_id`) are
  **not** this slice — ENG-983 / existing 403.
- `security.mcpServer.test.ts` `INTERNAL_TOOL_NAMES` does **not** include
  `edit_landing_page_file` or `freeze_user_account`. Characterization tests
  must grow; they currently pin generate_image as hidden (Q-014 will
  invert that row).

## Q-004 overlap resolved

Cycle 3 bundled `freeze_user_account` into Q-004 (`internalOnly` on
outbound/admin). Freeze is **admin**, not customer-outbound.
`post_on_account` is customer social publish (ENG-827 mid-flight
withdraw already exists). Split:

- **Q-004** (keep): `post_on_account` only — `internalOnly` for all
  external MCP. Do not unlist `manage_*` (ENG-983).
- **Q-015** (ready): always-admin tools. First slice hides/refuses
  `freeze_user_account`, `list_all_clients`, `manage_user_notes`. Do not
  wait for ListTools-isAdmin (no identity on the list handler today);
  `internal`+`internalOnly` is the bounded PR. Admins keep partner-portal
  and in-app Emma (`ADMIN_SKILL_TOOL_NAMES` in `agentModeService.ts`).

## Queue effect

- Q-006 KEEP → **ready** — `briefs/Q-006-hide-edit-landing-page.md`
- Q-015 KEEP → **ready** — `briefs/Q-015-hide-admin-mcp-tools.md`
- Q-004 narrowed (drop freeze). Score unchanged. Still keep.
- Implementation order unchanged: Q-001, Q-014, Q-003. Hygiene (006/015)
  after those, or in parallel once MCP listing is intentional.

## Not this cycle

ENG-381 still unconfirmable. Comfy/Remotion: no new file-level fact.
