# OpenRouter Gateway Contract and Migration Inventory

**Owner:** ENG-1413 program; foundation: ENG-1414
**Status:** inventory baseline — no consumer traffic moved by this document

## Contract

AgentWeb decides a logical model for a task. The gateway converts only the
logical `openrouter/<provider>/<model>` identifier into OpenRouter's
`<provider>/<model>` wire identifier. It owns the HTTP request boundary,
bounded timeout, typed transport errors, streamed terminal usage extraction,
and exactly-one ledger event keyed by the logical decision and request event ID.

The gateway must accept tool calls, structured output, streaming and supported
multimodal inputs without exposing provider transport choices to task code.
OpenRouter owns upstream-provider selection, provider retry/fallback, and
throttling. AgentWeb must not add a fallback graph after an OpenRouter failure.

| Field | Meaning |
| --- | --- |
| `taskClass` | Stable product task taxonomy supplied by the caller. |
| `logicalModelId` | AgentWeb ID retained for policy, entitlement, and ledger attribution. |
| `upstreamModelId` | Validated `provider/model` ID sent only at the OpenRouter boundary. |
| `eventId` | Idempotency key for one completion's cost/usage event. |
| `usage` | Actual input, output, cache-read, cache-write tokens and OpenRouter cost. |
| `error` | Typed auth, invalid-model, rate-limit, timeout, malformed-response, or stream-terminal error. |

`normalizeOpenRouterModelId` in `src/utils/openRouterGatewayContract.ts` is the
only model-ID transformation. It intentionally performs no network access,
provider selection, retry, or fallback.

## Direct text/chat/tool inventory at baseline

Each row is a production consumer or transport boundary, not a test. A later
migration slice must delete the noted direct transport or record a narrowly
reviewed capability exception. Image/video generation is out of text/chat/tool
scope and is not a reason to retain native Gemini text generation.

| Consumer | Code location | Current transport | Required capability | Migration owner |
| --- | --- | --- | --- | --- |
| Interactive Agent Mode | `services/agentModeService.ts` (`callLLM`, model clients) | Azure/OpenAI, Bedrock, Gemini, OpenRouter | streaming, tools, JSON, vision, cache usage | ENG-1415 interactive |
| Agent Mode native Gemini shim | `services/agentMode/core/geminiNativeClient.ts` | Gemini Developer API | tools, structured output, usage | ENG-1415 interactive |
| Scheduled social engagement | `cron/socialEngagementExecutor.ts` | Gemini-compatible client | JSON/content | ENG-1415 scheduled |
| LinkedIn connection sync | `cron/linkedInConnectionSyncCron.ts` | OpenAI client | text/structured output | ENG-1415 scheduled |
| Task generation | `routes/tasks.ts` | OpenAI client | text/structured output | ENG-1415 scheduled |
| Content/blog generation | `controllers/blog.ts`, `services/agentModeService.ts` | Gemini and OpenAI-compatible calls | long text/structured output | ENG-1415 content (ENG-761 regression) |
| Workflow generation | `services/workflowGenerator.ts` | OpenAI client | structured output | ENG-1415 content |
| Slack generation | `routes/slack.ts` | Gemini Developer API | text | ENG-1415 MCP/API |
| MCP workflow tools | `mcp/server/workflowTools.ts` and Agent Mode callers | inherited Agent Mode transport | tools/structured output | ENG-1415 MCP/API |
| CRM enrichment | `services/crmEnrichmentService.ts` | OpenAI-compatible client | JSON, retries, metering | ENG-1415 judge/dedup/scoring |
| Field alias/enrichment cluster | `services/enrichmentFieldAliasService.ts`, `services/enrichmentClusterService.ts` | OpenAI-compatible client | structured output | ENG-1415 judge/dedup/scoring |
| Invite note/growth/report revision | `services/inviteNoteShortener.ts`, `services/growthGeniusService.ts`, `services/reportRevisionService.ts` | OpenAI-compatible client | text | ENG-1415 remaining callers |
| Shared LLM service | `utils/llmService.ts` | LangChain Bedrock/Gemini | streaming, JSON, metering | ENG-1415 remaining callers |
| Coding/cloud agent | `services/codingAgentService.ts` | Anthropic Bedrock | tools, long-running streams, cache | ENG-1416 |
| Agent engine | `agent-engine/web_agent.py` | OpenAI-compatible client | browser-tool workflow | ENG-1416 |

## Narrow non-text exceptions

| Exception | Missing OpenRouter capability evidence | Owner | Review date | Removal condition | Call sites |
| --- | --- | --- | --- | --- | --- |
| Gemini Live voice | OpenRouter's chat gateway does not provide the bidirectional live-audio session used by `ai.live.connect`. This exception excludes ordinary Gemini text generation. | ENG-1416 | 2026-09-20 | OpenRouter supports the required realtime audio/session semantics and parity passes. | `services/liveVoiceService.ts` |
| Veo video generation | Video generation is not a supported text/chat/tool completion and is billed per video, not completion tokens. | ENG-1416 | 2026-09-20 | OpenRouter offers the required video generation contract and parity passes. | `services/videoGeneration.ts` |

## Baseline evidence required before consumer cutover

1. Characterization tests covering message, streaming, tool, structured-output,
   malformed usage/error, and exactly-once metering behavior for each task class.
2. Existing-ledger snapshots for logical model, task class, actual cost, cache
   tokens, latency, and outcome signal.
3. Okareo baseline-versus-changed simulation result per LLM-path slice.
4. Shared-staging and bounded live-matrix result recorded against an exact SHA.
