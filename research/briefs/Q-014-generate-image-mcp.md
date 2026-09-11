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

Cycle 47: do **not** copy in-app availability onto MCP. Chatbot injects
`generate_image` only on the `images` page (`chatbotService.ts` L5211).
Agent Mode uses `buildSkillContext` and does **not** put
`generate_image` in `DEFAULT_FOUNDATION_TOOLS` (`describe_image` was
promoted instead, ENG-260, L6166–6171). Hermes has no AgentWeb URL and
no skill install step — Q-014 is `tools/list` for an authenticated MCP
session. Do not add the name to `DEFAULT_FOUNDATION_TOOLS` (#2861 is
that move for `convert_to_pdf`). Do not edit `chatbotService.ts` (#1076).

Cycle 49: do **not** add `generate_image` to `ANONYMOUS_TOOLS`
(`anonymousTransport.ts` L48–58). When `MCP_ANONYMOUS_DISCOVERY=true`,
anonymous `tools/list` will already include the listed tool; execute
is blocked at the transport. Authenticated Hermes (Q-001) still
meters `POST /api/emma/generate-image`.

Cycle 50: do **not** add `requiresUserAccount` on MCP `generate_image`
as part of this listing PR. A leaked CallTool already dies at
`lookupUser` (`httpClient.ts` L57–66) before spend. ENG-822 on this
tool would only change the error string, not the product.

Cycle 51: do **not** treat `requireEmmaTokenBudget` as the anonymous
spend door. `checkTokenUsage` allow-lists `anon_*` under $2 vs
ChatSessions; MCP image calls do not create those rows. Authenticated
Hermes still hits a real user row and the monthly cap.

Cycle 53: do **not** add `client_id` / `resolveClientScopedContext` on
MCP `generate_image`. Execute stays `ctx(context)`. That skip of
`lookupUser` is admin list/manage only.

Cycle 39: do **not** copy Emma’s in-app schema onto MCP in this slice.
The MCP face (`apiTools.ts` L2075–2094) is snake_case, has no `confirm`
or `metrics_verified`, and `emmaApi.ts` L181 passes `confirm` as
`undefined`. That is why external MCP cannot self-approve image *edits*.
Text-to-image (no `input_images`) is the acceptance path. Do not put
`session_id` on the body here — MCP session ids are not Emma chat
sessions. After the flag drop, update the stale comment at
`mcp.apiTools.test.ts` L405–406 (tool will be in `getToolDefinitions()`);
keep L407–421 via `getTool()`.

## Collision

ENG-983 unlists CRUD; this is additive. Don't touch `manage_*` listing.

## Rollback

Restore `internal: true` on `generate_image` and put the name back on
`mcp.apiTools.test.ts` L91.
