# Architecture brief (living)

Status: **cycle 5**. Deepens every cycle. Full teach-in after `briefing_ready`.

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
                                   ├─ Playwright MCP (@playwright/mcp 0.0.70)
                                   │    headless + isolated per Agent Mode session
                                   └─ agent-engine (Python, browser-use)
                                      polls AW-TaskExecutions (max 3 concurrent)
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
`externalMcp`, ENG-974), `requiresUserAccount`, evaluation gate.

**Hermes sees a different catalogue than Emma.** MCP lists ~80 REST-wrapping
tools (`apiTools` + `emma_*` workflow layer + `evaluation_workspace`) and
**hides** `generate_image`. `coding_agent`, `generate_video`, and
`compose_video` are not on MCP at all. ENG-982 added job-shaped `emma_*`
tools; ENG-983 (unlist the granular CRUD) is the team's planned follow-up —
do not duplicate it. `edit_landing_page_file` is still listed and deprecated.
`freeze_user_account` is listed to every OAuth client.

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

## Browsers (cycle 5)

Agent Mode Playwright MCP is **not** the agent-engine. The MCP client injects
`--headless --isolated`, so it cannot hold WhatsApp Web. Cookie persistence
(`AW-BrowserCookies`) exists for Emma; agent-engine has a separate S3
`CookieSync`. `local-agent-relay` (Codex + ngrok) was retired ENG-383;
replacement is ENG-381 — the Hermes-shaped local logged-in browser.

## What this brief still owes Kevin (later cycles)

- Work plans vs skills decision rule with a real example
- How scheduled chats differ from interactive (controller policy)
- Customer-portal surfaces we cannot see from this repo
- Full teach-in prose (cycle 6)
