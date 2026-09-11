# Cycle 71 — CallTool wrap files are empty on AgentWebPro

**UTC:** 2026-09-11T21:10:00Z
**Kind:** collision
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycles 69–70: the in-process drain fix is `cronJobRegistry.track` on
`CallTool`. Is that file set still empty on AgentWebPro, or would a
wrap PR collide?

## Finding

**Empty. 20 open AgentWebPro PRs. Zero touch `mcpServerCore.ts`,
`mcpServer.ts`, `mcpSessionRehydration.ts`, `cronJobRegistry.ts`,
`asgLifecycleGuard.ts`, `apiTools.ts`, `httpClient.ts`, or
`server.ts`. The wrap window is clear. Do not land it on the
research branch, and do not start it instead of Q-014.**

### This scan (2026-09-11, 20 PRs)

Same count as cycle 61. Drain/MCP wrap set is **new** emptiness
(cycle 61 checked A-017 files + `apiTools` / `loops/core`).

| File | AgentWebPro |
|---|---|
| `mcp/server/mcpServerCore.ts` | **none** |
| `mcp/server/mcpServer.ts` | **none** |
| `mcp/server/mcpSessionRehydration.ts` | **none** |
| `utils/cronJobRegistry.ts` | **none** |
| `services/asgLifecycleGuard.ts` | **none** |
| `mcp/server/apiTools.ts` | **none** (kvnloo **#2**) |
| `mcp/server/httpClient.ts` | **none** |
| `server.ts` | **none** |
| `loops/core/**` | **none** (kvnloo **#3**) |

### Still occupied (do not compete)

| File | PRs |
|---|---|
| `emma/tools.ts` | **#2832 #1076 #689** |
| `app.ts` | **#2271 #1814** |
| `routes/crm.ts` | **#1544 #1790** |
| `agentModeService.ts` | **#2871 #2861 #2563 #2060 #1584** |

`#2393` still owns Slack `conversation/channelPort` (not `server.ts`).
`#2862` is `toolErrorClassifier.ts` (not `callLLM` this scan). Never
**#2862 #2271 #2861**.

This fork: kvnloo#1 (artifact), **#2 MERGEABLE** Q-014+Q-004, **#3
MERGEABLE** A-002. Wrap CallTool only after or with a slice that
already owns `mcpServerCore` (A-007 waits on #2). Not a fifth
`listen()`.

## Queue effect

No rank change. A-006 stays discard. Q-001 / Q-014 / Q-003 stay
ready. A-007 still waits on #2. A-017 still parked (`crm.ts` occupied).

## Next

Cycle 72: cheapest remaining mapping. Do not un-ready Q-001 /
Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
