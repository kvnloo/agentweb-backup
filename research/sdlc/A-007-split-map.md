# A-007 split map (research only — do not land this PR yet)

`coding_unlocked` is false. Cycle 24. Collision on `apiTools.ts`: **empty**.

Cycle 18 listed section *line numbers*. This file names the **tools** and
corrects the draft tree in `MODULE_MAP.md`.

## Do not copy Hermes one-file-per-tool in the first PR

Hermes `tools/*.py` started as one file per tool. AgentWeb already has
the in-tree proof of a *section* extract: `workflowTools.ts` (ENG-982,
**5** `register()` calls, side-effect `import './workflowTools'` in
`mcpServerCore.ts`). Retrofitting **85** files in one PR is factory-spray
and would fight `mcp.apiTools.test.ts` (imports the barrel, not each tool).

First slice = one sibling file of mcpFetch-only tools, barrel from
`apiTools.ts`. One-file-per-tool later, after the barrel exists.

Cycle 28: Hermes `discover_builtin_tools()` AST-scans `tools/*.py`.
Do **not** add that in the first A-007 PR. Keep the ENG-982 explicit
`import './workflowTools'` / `apiTools` list.

## Barrel contract (must keep)

| Importer | Specifier |
|---|---|
| `mcpServerCore.ts` L26 | `import './apiTools'` |
| `emma/tools.ts` L7240 | `import '../mcp/server/apiTools'` |
| `mcp.apiTools.test.ts` L44 | `import '../mcp/server/apiTools'` |
| `mcp.apiTools.clientScope.test.ts` | same barrel |

Do **not** also `import './tools/infrastructure'` from `mcpServerCore.ts`
or tools would double-register. ENG-982 used core-import because
`workflowTools` is *not* inside the `apiTools` barrel.

Do **not** edit `emma/tools.ts` (A-004 / Q-004 / #2832 / #689 / #1076).

## Header lie vs Hermes import DAG

`apiTools.ts` L3–9: “No direct service calls — all tools route through
the REST API.” False today:

| Kind | Specifier | Why |
|---|---|---|
| static | `services/workPlanSteps` L1 | work-plan merge helpers |
| static | `services/prDigestService` L14 | `get_pr_digest` |
| **dynamic** | `await import('../../services/agentModeService')` | **L1406, 1442, 1970, 1991** |

Hermes tools do not import `run_agent.py`. These four dynamic imports
*are* the loop. That is why A-006 (HTTP-per-tool) stays discarded: blog
and skill-install already need the 40k in-process object. Do not move
the Content section in the same PR as Q-014.

## `generate_image` is not in Content

| Section header | Line | Tools | Loop import? |
|---|---|---|---|
| Content (internal tools — call agentModeService directly) | 1381 | `create_blog_article`, `publish_blog_article` | **yes** (L1406, 1442). Both `internalOnly` |
| Internal-only → comment “Infrastructure tools” (not its own `───` header) | 1996 | `you_search_web`, `you_search_news`, `google_search_web`, **`generate_image`**, `send_email` | **no** (mcpFetch). Skills above them (`install_skills`, `list_available_skills`) **yes** (L1970, 1991) |

`MODULE_MAP.md` previously said `tools/content.ts ← generate_image,
send_email`. That would drag blog’s `agentModeService` import into the
Q-014 file. **Wrong.**

Q-014 still: drop `internal: true` on `generate_image` (L2077). It is
**not** `internalOnly`. `send_email` is `internalOnly` (L2115) — leave it.

## First slice (when unlocked, not instead of Q-014)

Move **only** the five mcpFetch infrastructure tools into
`backend/src/mcp/server/tools/infrastructure.ts`.

Leave in `apiTools.ts` for this PR:

- Content section (blog + loop import)
- `install_skills` / `list_available_skills` (loop import; same Internal-only block)
- Landing, CRM, admin, work plans, etc.

`apiTools.ts` becomes:

```ts
import './tools/infrastructure';
// remaining register() calls
```

Acceptance: `mcp.apiTools.test.ts` still green; `generate_image` still
registered once; no new `mcp → agentModeService` edge in the new file.

## Later section files (not the first PR)

| Proposed file | Header | n | Notes |
|---|---|---|---|
| `tools/session.ts` | Emma Chat Sessions | 6 | mcpFetch |
| `tools/tasks.ts` | Tasks | 4 | |
| `tools/schedules.ts` | Schedules + templates + scheduled chats | 2+6+3 | can stay one file or three |
| `tools/crm.ts` | CRM / Leads | 4 | Q-004 is `post_on_account` in Connected Accounts, not here |
| `tools/gtm.ts` | GTM Plans | 3 | |
| `tools/knowledge.ts` | Knowledge Base | 3 | |
| `tools/brand.ts` | Brand & Strategy | 2 | |
| `tools/blog.ts` | **Content** | 2 | **park** — loop import; A-003 adjacent |
| `tools/accounts.ts` | Connected Accounts | 2 | Q-004 `post_on_account` |
| `tools/landing.ts` | three landing headers | 6+2+10 | Q-006 `edit_landing_page_file` |
| `tools/infrastructure.ts` | **first slice** | 5 | Q-014 |
| `tools/skills-session.ts` | install/list skills | 2 | loop import; park |
| `tools/workplans.ts` | Predefined Work Plans | 2 | |
| `tools/admin.ts` | remaining admin headers | rest | Q-015 lives in PR Digest + Client Health |

Do not add A-010 (close the dynamic imports) this cycle — same owner as
A-003 / Q-010.
