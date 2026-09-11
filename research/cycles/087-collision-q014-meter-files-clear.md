# Cycle 87 — AgentWebPro still empty on Q-014 / meter / wrap files

**UTC:** 2026-09-11T21:45:00Z
**Kind:** collision
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 71 (20 PRs): wrap + `apiTools.ts` + `loops/core` empty.
Cycles 81–86 mapped quota/meter/price onto
`emmaTokenBudget.ts` / `tokenUsageService.ts` / `llmPricing.ts` /
`imageGeneration.ts` / `videoGeneration.ts`. Has upstream moved onto
those files — or onto Q-014’s listing file — so that a nanoservice
or a wait would be cheaper than kvnloo#2?

## Finding

**Still empty. 20 open AgentWebPro PRs. Zero touch the Q-014
listing file, the MCP wrap set, `loops/core`, or the cycle 81–86
meter/price files. New #2875 is a cron. Do not wait. Do not
HTTP-split to dodge a collision that is not there.**

kvnloo **#2** (Q-014+Q-004) and **#3** (A-002) remain OPEN /
MERGEABLE.

### Empty this scan (2026-09-11T21:42Z, 20 PRs)

Cycle 71 wrap set, plus the cycle 81–86 set:

| File | AgentWebPro |
|---|---|
| `mcp/server/apiTools.ts` | **none** (kvnloo **#2**) |
| `mcp/server/httpClient.ts` | **none** |
| `mcp/server/mcpServerCore.ts` | **none** |
| `mcp/server/mcpServer.ts` | **none** |
| `mcp/server/mcpSessionRehydration.ts` | **none** |
| `utils/cronJobRegistry.ts` | **none** |
| `services/asgLifecycleGuard.ts` | **none** |
| `server.ts` | **none** |
| `loops/core/**` | **none** (kvnloo **#3**) |
| `middleware/emmaTokenBudget.ts` | **none** |
| `services/tokenUsageService.ts` | **none** |
| `services/usageRecorderService.ts` | **none** |
| `utils/llmPricing.ts` | **none** |
| `services/imageGeneration.ts` | **none** |
| `services/videoGeneration.ts` | **none** |
| `routes/emmaApi.ts` | **none** |
| `middleware/rateLimiter.ts` | **none** |
| `services/spendChargingService.ts` | **none** |

### New / moved since cycle 71

| PR | Files | Notes |
|---|---|---|
| **#2875** | `cron/renewalIntegrationHealthCron.ts` + test | Not MCP, not meter, not `app.ts` |
| **#2862** | still `toolErrorClassifier.ts` + test | Not `callLLM` body. Never compete. |
| **#2393** | still `conversation/channelPort` / Slack adapter | Not `server.ts` |

### Still occupied (do not compete)

| File | PRs |
|---|---|
| `emma/tools.ts` | **#2832 #1076 #689** |
| `app.ts` | **#2271 #1814** |
| `routes/crm.ts` | **#1544 #1790** |
| `agentModeService.ts` | **#2871 #2861 #2832 #2563 #2060 #1584 #1076** |

Cycle 71’s agentMode pile omitted **#2832** and **#1076**; both
also edit the god object. A-003 / Q-010 stay park. `#2563` still
touches `sdkConstructionGuard.test.ts` — A-002 stays a **sibling**
test file (kvnloo#3).

Hermes/OMP: they ship package boundaries without waiting for a
20-PR pile on the loop file. AgentWeb’s listing file is empty
upstream. Cutting-edge is land Q-014 on that file, not extract a
process “because collision.”

## Queue effect

A-006 stays **discard**. Q-014 stays **ready** (listing file still
empty on AgentWebPro). Q-001 / Q-003 stay ready. A-007 still waits
on kvnloo#2, not on upstream. Wrap CallTool after #2, not instead.

## Next

Cycle 88: cheapest remaining mapping. Candidate: reconfirm Oh My
Pi package DAG / version (last live pin cycle 54: `0.85.1`).
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
