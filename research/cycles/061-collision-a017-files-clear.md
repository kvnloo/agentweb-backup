# Cycle 61 — collision: A-017 files clear except crm.ts

**UTC:** 2026-09-11T20:52:00Z
**Kind:** collision
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 57 last full collision. Cycles 59–60 parked A-017 on
`sessionSockets` / worker / enrichment / not `crm.ts`. Did AgentWebPro
move onto those files?

## Method

`gh api repos/AgentWebPro/agentweb/pulls?state=open` → **20** PRs (same
count as cycle 52/57). Then `.files` for every open PR. Watch:
`apiTools|httpClient|imageGeneration|mcpServerCore|loops/core|sessionSockets|anonymousTransport|emmaApi|tokenUsage|toolHelpers|workflowTools|crm.ts|crmEnrichmentService|generateMarketingResponseWorkerService|instanceState|fathomLinearPortRegistry|chatSocketHandler|ports.ts|app.ts|server.ts|emma/tools|sdkConstructionGuard|agentModeService|slackChannelAdapter`.

This fork: kvnloo#1 (artifact), #2 Q-014+Q-004, #3 A-002.

## Result

Q-014 / A-002 / A-007 targets still **empty** on AgentWebPro:

| Path | AgentWebPro open PR |
|---|---|
| `mcp/server/apiTools.ts` | **none** (fork **#2**) |
| `mcp/server/httpClient.ts` | **none** |
| `mcp/server/mcpServerCore.ts` | **none** |
| `mcp/server/toolHelpers.ts` | **none** |
| `mcp/server/workflowTools.ts` | **none** |
| `services/imageGeneration.ts` | **none** |
| `loops/core/**` | **none** (fork **#3**) |
| `services/sessionSockets.ts` | **none** |
| `services/crmEnrichmentService.ts` | **none** |
| `services/generateMarketingResponseWorkerService.ts` | **none** |
| `utils/instanceState.ts` | **none** |
| `services/fathomLinearPortRegistry.ts` | **none** |
| `services/chatSocketHandler.ts` | **none** |
| `loops/core/ports.ts` | **none** |
| `server.ts` | **none** |

A-017 first slice (expand `MinimalIo` + switch two `require('../server')`
sites) has **no** AgentWebPro collision. `crm.ts` does:

| PR | Hit | Implication |
|---|---|---|
| **#1790** | `routes/crm.ts` | Cycle 59; stale 2026-07-08 |
| **#1544** | `routes/crm.ts` | **New vs cycle 59.** ICP matching. Do not edit `crm.ts` |
| **#1814** | `app.ts` (HubSpot `crmSync`) | **#2271 is not the only `app.ts` owner.** A-007 still not `app.ts` |
| **#2271** | `app.ts`, `slackChannelAdapter`, WhatsApp, `db.ts` | A-013 not WhatsApp |
| **#2393** | `conversation/slackChannelAdapter.ts` | A-013 not Slack |
| **#2832 #1076 #689** | `emma/tools.ts` | Q-004 / A-004 off that file |
| **#2563** | `sdkConstructionGuard.test.ts` | A-002 sibling |
| **#2871 #2861 #2060 #1584** | `agentModeService.ts` | A-005 pile; #2861 convert_to_pdf — do not piggyback `generate_image` |

Never restack **#2862 #2271 #2861**.

## Queue effect

None. A-017 stays park; first slice files are clear; `crm.ts` is not
first slice. Q-001 / Q-014 / Q-003 stay **ready**. A-006 stays discard.

## Next

Cycle 62: cheapest remaining mapping (not another QUEUE restatement).
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
