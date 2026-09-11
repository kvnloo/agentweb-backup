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

In `backend/src/mcp/server/apiTools.ts` (or `tools/infrastructure.ts` if
A-007 has landed), **remove `internal: true`** from `generate_image`
(L2077). Do **not** add `emma_generate_image` in `workflowTools.ts` as
this PR — that wrapper would leave `generate_image` hidden and fail
acceptance #1 (`registry.ts` L82–86 `getToolDefinitions` filters
`!t.internal` only).

Required test edit: `mcp.apiTools.test.ts` L91 — drop `generate_image`
from `internalTools` so `externalNames` is allowed to contain it. Keep
L407–421 category schema via `getTool()`. Leave `send_email` on the
L91 list (`internalOnly`).

Keep `you_search_*` / `google_search_web` internal in this slice.

## Out of scope

ComfyUI backend, DesignArena routing (Q-003), video, changing prices.

## Collision

ENG-983 unlists CRUD; this is additive. Don't touch `manage_*` listing.

## Rollback

Restore `internal: true` on `generate_image` and put the name back on
`mcp.apiTools.test.ts` L91.
