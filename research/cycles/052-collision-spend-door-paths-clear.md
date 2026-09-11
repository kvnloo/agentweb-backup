# Cycle 52 — collision refresh (apiTools / lookupUser paths still clear)

**UTC:** 2026-09-11T20:38:00Z
**Kind:** collision
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006. **Do not merge:** A-015.

## Method

`gh api repos/AgentWebPro/agentweb/pulls?state=open` (20 PRs) then
`.files` for #2875 #2871 #2862 #2861 #2832 #2563 #2393 #2271 #1076 #689
#2060 #1584. Filter: `apiTools|imageGeneration|anonymousTransport|httpClient|emmaApi|tokenUsage|emmaTokenBudget|loops/core|loops/index|mcpServerCore|registry.ts|emma/tools|sdkConstructionGuard`.

This fork: kvnloo#1 (this artifact), #2 Q-014+Q-004, #3 A-002.

## Result

AgentWebPro is still **empty** on the cycle 50–51 spend-door files and on
the Q-014 / A-002 / A-007 targets:

| Path | AgentWebPro open PR |
|---|---|
| `mcp/server/apiTools.ts` | **none** (this fork **#2** owns it) |
| `mcp/server/httpClient.ts` | **none** |
| `mcp/server/anonymousTransport.ts` | **none** |
| `routes/emmaApi.ts` | **none** |
| `middleware/emmaTokenBudget.ts` | **none** |
| `services/tokenUsageService.ts` | **none** |
| `services/imageGeneration.ts` | **none** |
| `loops/core/**`, `loops/index.ts` | **none** (this fork **#3** owns the guard) |

Still do not compete:

| PR | Hit | Implication |
|---|---|---|
| **#2832 #1076 #689** | `emma/tools.ts` | Q-004 / A-004 stay off that file |
| **#2563** | `sdkConstructionGuard.test.ts` | A-002 sibling file, already in #3 |
| **#2861 #2871 #2060 #1584** | `agentModeService.ts` | A-005 pile; #2861 is convert_to_pdf foundation — do not piggyback `generate_image` |
| **#2862** | no match in this filter | OpenRouter 429; never restack |
| **#2271** | no match | WhatsApp; Q-011 park |
| **#2393** | no match on Slack/MCP/loops filter | A-013 must not start at `routes/slack.ts` |
| **#2875** | no match | ENG-1541 renewal-health; ignore |

## Queue effect

None. Q-001 / Q-014 / Q-003 stay **ready**. A-007 still waits on kvnloo#2.
A-006 stays discard (cycles 50–51: lookupUser is the hop spend door;
copying the Emma meter is not). A-015 stays park.

## Next

Cycle 53: cheapest remaining mapping **or** stop if `stop_after`.
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
