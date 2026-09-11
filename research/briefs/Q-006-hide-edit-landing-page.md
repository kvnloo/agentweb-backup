# Q-006 brief — hide deprecated full-file landing edit on MCP

Status: **ready** (flags + description rewrites; no schema). Not in the
first three PRs. `coding_agent` stays in-app only.

## Problem

MCP lists `edit_landing_page_file` (`apiTools.ts` L1770) with a
description that says use `coding_agent`. `coding_agent` exists only on
`emmaToolRegistry` (`emma/tools.ts` L7511). Hermes `tools/call` of that
name is "tool not found". Four sibling landing-page tools repeat the same
lie (list/read files, check deploy, get preview URL).

The deprecated tool still *works* (PUT github-edit with full file
content). That is a write. ENG-974: outbound/write → `internalOnly`, not
hide-only.

## Acceptance

1. `mcpToolRegistry.getToolDefinitions()` does not include
   `edit_landing_page_file`.
2. External `execute` of `edit_landing_page_file` with
   `context.externalMcp === true` is refused (ENG-974), same pattern as
   `send_email`.
3. Descriptions of `list_landing_page_files`, `read_landing_page_file`,
   `check_landing_page_build`, `get_landing_page_preview_url` do not name
   `coding_agent`. They may say landing-page *edits* are in-app Emma only.
4. `coding_agent` is **not** added to `mcpToolRegistry`.
5. In-app Emma still has `coding_agent` via `emma/tools.ts`.
6. Do not edit `callLLM` or OpenRouter retry (#2862). Optional follow-up
   (not this PR): one-line note in `OPENROUTER_GATEWAY.md` that coding
   agent is OpenRouter Anthropic Messages, not Bedrock/Vertex.

## First slice

`apiTools.ts`: `internal: true`, `internalOnly: true` on
`edit_landing_page_file`. Rewrite the four descriptions. Extend
`security.mcpServer.test.ts` `INTERNAL_TOOL_NAMES` (or a sibling list) so
the hide+refuse is pinned. Q-014 will separately *remove* `generate_image`
from that hidden list — do not fight that test in this PR if both land
together; land 014 first or make the list explicit per-tool.

## Out of scope

Registering `coding_agent` on MCP (long timeout, metering, draft-branch
contract). Comfy. ENG-983.

## Collision

#2563 dead transports — don't revive them. #2862 callLLM retry. ENG-983
unlisting CRUD — this is not a `manage_*` change.

## Rollback

Remove the two flags; restore descriptions.
