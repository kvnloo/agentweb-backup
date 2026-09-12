# How we help together

Read [`README.md`](README.md) first (findings + priorities), then
`ARCHITECTURE.md` and `QUEUE.md`.

## Coding is unlocked

Kevin asked to start real PRs. Implementation order, not score.
Cycle 209: Q-014 / Q-004 first (in flight kvnloo#2), then Kevin Q-001
smoke, then Q-003 mapper. Q-003 still scores highest because the arena
snapshot is live; it still waits until Matt is ok with a default flip.

## First slices

Implementation order, not score.

| You | Agent |
|---|---|
| After kvnloo#2: Hermes host MCP OAuth against `api.agentweb.pro` using the **existing** `HERMES_MCP_OAUTH.md` recipe (`--connect-timeout 315`); report where it still breaks. `tools/list` should then include `generate_image`. | Optional Hermes skill in your hermes-agent tree. **Do not rewrite the in-repo runbook** unless the smoke finds a lie. |
| Confirm product intent: should external agents *see* image gen? (already yes — Q-014 is in flight) | Q-014: drop `internal: true` on MCP `generate_image`; tests; leave `send_email` internalOnly. Do **not** unify Emma vs MCP schema (A-011). |
| Taste call: is `gpt-image-2` acceptable as Emma's unspecific default? (arena #3, 3× cheaper than today's Gemini Pro default) | Q-003: fail-open DesignArena mapper + fixture from `mappings/designarena-image-models.md`; no new provider. Do not flip the hardcoded default (cycle 170 Azure `[0]`). |

None of these needs Harsha or a table.

MCP hygiene after those (or parallel once Q-014's listing tests exist):
Q-004 hide `post_on_account` (already in #2 with Q-014); Q-006 hide
`edit_landing_page_file`; Q-015 hide freeze / list_all_clients /
manage_user_notes. Do not unlist `manage_*` (ENG-983). Do not edit
`emma/tools.ts` (#2832).

## Do not pick up

CRM, HubSpot, Meta payload bugs, billing ledger, `agentModeService.ts`
rewrites, Kerdoios-inside-AgentWeb, ENG-983 catalogue unlisting, WhatsApp
Cloud API (#2271), ngrok revival of `local-agent-relay`, porting HyperFrames
or MoneyPrinterTurbo into Remotion, listing `generate_video` on MCP before
Q-014.

## Architecture research (parallel)

Nanoservice mesh of Emma: **no**. Modular monolith + existing four
deploy units: **yes**. Map: `research/sdlc/THESIS.md`. SDLC first
slices after unlock (not instead of Q-014): A-002, **A-019**, A-007,
A-008. Do not edit `crm.ts` / `slack.ts` as architecture first slices
(A-017 parked; ENG-1286; Slack #2393).

## If we only do one product thing

**Q-014.** OAuth already exists; without listing `generate_image`, Hermes
cannot participate in the creative stack your other repos are about.
Land [kvnloo#2](https://github.com/kvnloo/agentweb/pull/2).

## If we only do one Kevin-unique thing after #2

**Q-001 smoke** on the existing runbook, so `tools/list` includes
`generate_image`.

## If we only do one architecture thing after #2 and #3

**A-019.** HTTP 503 on POST `/mcp` when the body contains
`tools/call` (copy `anonymousTransport` batch fail-closed), then
wrap CallTool **handler return** in `track()` so drain waits. `/generate` gets 503
before `tryClaim`. Do **not** drain-gate ListTools or initialize
(cycle 211). Do **not** 503 GET `/mcp` (cycle 212: SDK throws;
405 is the optional-SSE skip). After the four-way wait,
`await mcpShutdown` then `server.close`; **drop** the sibling
SIGTERM in `mcpServer.ts` (cycle 213: ASG never fires it;
Sunday SIGTERM runs it first and aborts the shared transport).
Do not return CallTool `isError` for drain (HTTP 200 tool-failure).
Do not refuse inside `track()` (the promise is already running).
Do not make `tryClaim` return false (that 409s). `mcpShutdown`
triggers GET `streamController.close()`; Hono then
`writable.end()`s — do not await `server.close` for that hang
(cycle 214). Wrap `CallTool` in `mcpServerCore` so rehydrate is
covered; do not `sessions.set` that JSON transport (cycle 215).
Keep rehydrate `finally close()` after `handleRequest` returns
(cycle 216: leftover `_streamMapping`; cannot hang).
`mcpShutdown` is not `generate_image` cancel (cycle 217: the
wait is the billed hop). Wrap the CallTool **handler return**,
not only `execute` (cycle 218: `send()` after `close()` is
Protocol `_onerror`, not `isError`; drain polls size and does
not await `send()`). Closed POST SSE is not ENG-97 404 reinit
(cycle 219: POST `_handleSseStream(..., false)`; no `eventStore`;
Q-001 fixture is httpx `next(data:)`). Default SDK `callTool()`
is 60s (`Protocol.request`); inbound CallTool has none (cycle 220).
`notifications/cancelled` is a **new POST**, not the CallTool SSE
(cycle 221: client HTTP `send()` ignores `relatedRequestId`; server
202s; after `mcpShutdown` it cannot abort the original CallTool). Do
**not** 503 that notification. Copy `method === 'tools/call'`.
That is the billed-image drain gate. Not A-007 packaging. Not persist
(occupied `agentModeService.ts` / `app.ts` / `emma/tools.ts`).
