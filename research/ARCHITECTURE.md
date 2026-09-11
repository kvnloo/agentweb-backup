# Architecture brief (living)

Status: **cycle 2**. Deepens every cycle. Full teach-in after `briefing_ready`.

## What AgentWeb actually is

A billed, multi-tenant **AI marketing operator**. Users talk to Emma. Emma has
tools for ads (Meta, LinkedIn, Google), CRM, social, landing pages, images,
video, books, and knowledge bases. It is not a generic chatbot and not a
generic browser agent — though it still has one.

## Three runtimes

```
customer-portal (separate repo)  ─┐
partner-portal (this repo, admin) ─┼─► backend Express API + Socket.IO
                                   │       │
                                   │       ├─ Agent Mode worker (Emma tools, OpenRouter)
                                   │       ├─ MCP /oauth + /mcp  (external agents, Hermes)
                                   │       └─ DynamoDB + S3
                                   │
                                   └─ agent-engine (Python, Playwright/browser-use)
                                      polls AW-TaskExecutions for classic web tasks
```

| Runtime | When it runs | LLM path |
|---|---|---|
| Agent Mode | Interactive + scheduled chats | `callLLM` → OpenRouter (text/tool/vision law) |
| Emma sidebar | Socket.IO `message` | Also `callLLM`, smaller tool set |
| agent-engine | Polled Dynamo executions | Still direct Bedrock/Azure/Gemini (OpenRouter inventory exception) |
| Coding agent | Landing-page edits via `coding_agent` tool | OpenRouter Anthropic Messages, **diff edits** |
| Image/video | Emma tools | Direct Azure/Gemini/Runway/Higgsfield/Veo — **not** OpenRouter |

## The turn (Agent Mode)

Not "socket in, stream out" as the old README implies.

1. Client `POST /api/agent-mode/.../generate`
2. `agentModeController` claims a session lock, enforces timeouts / auto-continuation
3. `generateMarketingResponseWorkerService` forks a worker
4. `agentModeService.generateMarketingResponse` loops `callLLM` ↔ tools
5. Progress is **SSE** (`RunEmitter`); Socket.IO is used for some session fanout

Primary gravity wells:

- `backend/src/services/agentModeService.ts` (~40.5k lines)
- `backend/src/controllers/agentModeController.ts` (~15k)
- `backend/src/emma/tools.ts` (~9.8k)
- `backend/src/mcp/server/apiTools.ts` (~3.6k)

A strangler already exists under `backend/src/services/agentMode/`
(tool dispatch, finalize, work-plan, stream events, brand logo). The monolith
still grew. First PRs should extend a seam, not "split the file".

## Tools

In-process Emma tools register into `emmaToolRegistry`, copied into Agent Mode.
MCP HTTP tools wrap REST with a short-lived JWT so external agents cannot IDOR.
Flags that matter: `internal` (hide from `tools/list`, still callable — used for
metered cost tools, ENG-973), `internalOnly` (hide **and** refuse for
`externalMcp`, ENG-974), `requiresUserAccount`, evaluation gate. As of cycle 2,
only four API tools are `internalOnly`. `edit_landing_page_file` is still a
live deprecated tool.

## Money and models

- Text models: registry + Artificial Analysis quality scores + cost tiers + same-family dominance hiding.
- Images: `SUPPORTED_MODELS` in `imageGeneration.ts`; default `gemini-3-pro-image-preview`; failover only for implicit text-to-image.
- Video: Seedance (`seedance-2.0` / Higgsfield MCP) → Veo; Remotion Lambda for brand overlays.
- Usage: `meterUserUsage` on success. Usage runway recommends cheaper models. **Do not reimplement Kerdoios.**

## Trust boundaries

- JWT; delegated admin sessions make `req.user` the **customer**.
- Credentials for target sites are not stored for classic tasks; OAuth tokens for ads/CRM are.
- Evaluation workspaces are isolated `eval_*` users with a connector-free Meta simulator.
- Database/schema is a Harsha gate.

## What this brief still owes Kevin (later cycles)

- Work plans vs skills decision rule (already in README) with a real example
- How scheduled chats differ from interactive (controller policy)
- agent-engine cookie sync and why WhatsApp/WeChat still fail
- Customer-portal surfaces we cannot see from this repo
