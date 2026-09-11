# How we help together

Read `ARCHITECTURE.md` first, then `QUEUE.md`.

## Mode until you say "code"

Research loop keeps re-ranking until `stop_after` (20:15 UTC) or you say
start. `coding_unlocked` is still false. READY briefs exist so the first PRs
are specified, not invented at the keyboard.

## First pair of slices (when you unlock)

| You | Agent |
|---|---|
| Hermes host: complete MCP OAuth against `api.agentweb.pro` using the Q-001 runbook; report where it still breaks | Tighten `HERMES_MCP_OAUTH.md`; optional Hermes skill in your hermes-agent tree |
| Confirm product intent: should external agents *see* image gen? | Q-014: `emma_generate_image` workflow tool or un-hide `generate_image`; tests; leave `send_email` internalOnly |

Neither slice needs Harsha or a table.

## Do not pick up

CRM, HubSpot, Meta payload bugs, billing ledger, `agentModeService.ts`
rewrites, Kerdoios-inside-AgentWeb, ENG-983 catalogue unlisting, WhatsApp
Cloud API (#2271), ngrok revival of `local-agent-relay`.

## If we only do one thing

**Q-014.** OAuth already exists; without listing `generate_image`, Hermes
cannot participate in the creative stack your other repos are about.
