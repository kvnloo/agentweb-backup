# How we help together

Read [`README.md`](README.md) first (findings + priorities), then
`ARCHITECTURE.md` and `QUEUE.md`.

## Coding is unlocked

Kevin asked to start real PRs. Implementation order, not score.
Q-003 scores higher because the arena snapshot is live; it still waits
until Matt is ok with a default flip.

## First slices

Implementation order, not score. Q-003 scores higher because the arena
snapshot is live; it still waits until Matt is ok with a default flip.

| You | Agent |
|---|---|
| Hermes host: complete MCP OAuth against `api.agentweb.pro` using the **existing** `HERMES_MCP_OAUTH.md` recipe (`--connect-timeout 315`); report where it still breaks | Optional Hermes skill in your hermes-agent tree. **Do not rewrite the in-repo runbook** unless the smoke finds a lie. |
| Confirm product intent: should external agents *see* image gen? | Q-014: `emma_generate_image` workflow tool or un-hide `generate_image`; tests; leave `send_email` internalOnly |
| Taste call: is `gpt-image-2` acceptable as Emma's unspecific default? (arena #3, 3× cheaper than today's Gemini Pro default) | Q-003: fail-open DesignArena mapper + fixture from `mappings/designarena-image-models.md`; no new provider |

None of these needs Harsha or a table.

MCP hygiene after those (or parallel once Q-014's listing tests exist):
Q-004 hide `post_on_account` (do this with/before Q-014); Q-006 hide
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
slices after unlock (not instead of Q-014): A-002, A-007, A-008.
Do not edit `crm.ts` / `server.ts` as architecture first slices (A-017
parked; ENG-1286).

## If we only do one product thing

**Q-014.** OAuth already exists; without listing `generate_image`, Hermes
cannot participate in the creative stack your other repos are about.
