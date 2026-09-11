# Q-014 brief — expose generate_image on external MCP tools/list

Status: **ready** (one flag + tests; metering unchanged).

## Problem

`apiTools.ts` registers `generate_image` with `internal: true` (ENG-973).
Hermes `tools/list` omits it. `generate_video` / `compose_video` are not
registered at all. Kevin's DesignArena/Comfy work cannot attach to Emma
content gen through MCP discovery.

ENG-973 hid cost tools so strangers don't *see* them; they remain callable
by name and `/api/emma/generate-image` is metered. Listing the tool does not
bypass the meter.

## Acceptance

1. `mcpToolRegistry.getToolDefinitions()` includes `generate_image`.
2. External `execute` still hits `/api/emma/generate-image` (existing meter).
3. `category` remains required (`ad` | `organic_post`).
4. `send_email` stays `internalOnly`.
5. Characterization test: listed for external; `internalOnly` tools still hidden.

## First slice

In `backend/src/mcp/server/apiTools.ts`, remove `internal: true` from
`generate_image` **or** add `emma_generate_image` in `workflowTools.ts` (ENG-982
style) and keep the granular tool internal.

Prefer the `emma_generate_image` workflow wrapper if we want a job-shaped name
for Hermes without un-hiding the rest of the cost tools.

## Out of scope

ComfyUI backend, DesignArena routing (Q-003), video, changing prices.

## Collision

ENG-983 unlists CRUD; this is additive. Don't touch `manage_*` listing.

## Rollback

Restore `internal: true` / drop the wrapper tool.
