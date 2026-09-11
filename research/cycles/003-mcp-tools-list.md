# Cycle 003 — what Hermes actually sees

**When:** 2026-09-11  
**Focus:** MCP `tools/list` as `externalMcp=true`.

## Two registries, not one

Hermes does **not** load `emma/tools.ts`. `mcpServerCore.ts` imports only
`apiTools`, `evaluationTools`, `workflowTools`. Agent Mode copies Emma's
in-process registry. External agents and Emma do not share a tool list.

`ListToolsRequestSchema` returns `mcpToolRegistry.getToolDefinitions()`,
which drops `internal: true` only. `internalOnly` is a separate execute-time
refuse (ENG-974). Comment at mcpServerCore L77 ("ALL clients now see all tools")
is stale; so is "All 30 tools" at L7.

## Inventory (apiTools.ts + workflow + evaluation)

| Class | Count (approx) | Examples |
|---|---|---|
| Listed to Hermes | ~80 | `manage_*`, `list_*`, `post_on_account`, `generate_landing_page`, `emma_run_marketing_task`, `evaluation_workspace`, admin `freeze_user_account` |
| Hidden (`internal`) | 11 | `generate_image`, searches, `save_file`, `list_available_skills` |
| Hidden **and** refused (`internalOnly`) | 4 | `create_blog_article`, `publish_blog_article`, `install_skills`, `send_email` |

`generate_image` is `internal: true` and **not** `internalOnly` (`apiTools.ts`
~L2076). Hermes cannot discover it; a client that knows the name can still
call it (metered, ENG-973). `generate_video` / `compose_video` / `coding_agent`
are **absent** from the MCP registry entirely.

## Outbound tools still listed

- `post_on_account` — live social publish; ENG-827 mid-flight withdraw exists;
  **not** `internalOnly`.
- `publish_landing_page_changes`, `deploy_landing_page`, `generate_landing_page`
  — listed; generate+deploy is one step.
- `freeze_user_account` — listed to every OAuth client. Copy says "Admin only";
  REST will 403 non-admins, but the name is in every `tools/list`.

## Official collision: ENG-983

ENG-982 already shipped job-shaped `emma_*` tools (`workflowTools.ts`)
**additively**. Tests pin that granular tools stay listed until ENG-983
unlists them (`workflowTools.test.ts` "leaves the granular tools registered").

**Q-004 must not be "unlist the catalogue".** That is ENG-983.

## Queue mutations

- New **Q-014**: expose a creative subset (`generate_image`, later video) on
  external `tools/list` so Hermes/DesignArena can actually do content gen.
- Narrow **Q-004** to outbound/admin flags that are not ENG-983
  (`post_on_account`, `freeze_user_account`).
- **Q-006**: `coding_agent` is not an MCP tool; descriptions still tell
  clients to use it. Hide `edit_landing_page_file` or register a real MCP
  coding path — do not recommend a missing tool.
