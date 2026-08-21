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

Every production text/chat/tool completion reaches one of the boundaries below.
Rows group callers only when they share the same construction, credential, and
model-selection path. A later migration slice must delete the noted direct
transport or record a narrowly reviewed capability exception. The TypeScript and
Python import guards fail when a new provider boundary appears outside this
inventory.

| Consumer / boundary | Code location(s) | Current SDK, credential, and model-ID path | Required capability | Migration owner |
| --- | --- | --- | --- | --- |
| Interactive Agent Mode | `services/agentModeService.ts` (`callLLM`, client constructors), `controllers/agentModeController.ts` | OpenAI SDK -> Azure env endpoint/key/deployment for `gpt-*`; Bedrock SDK -> workload IAM or `prod/AgentWeb/Bedrock/ApiKey` for `anthropic.*`; Google SDK -> `GEMINI_API_KEY` or `prod/AgentWeb/GeminiAPIKey` for `gemini-*`; Vertex REST -> `prod/AgentWeb/Google/Vertex` for `claude-*`; OpenAI SDK -> `prod/AgentWeb/OpenRouter` after stripping `openrouter/` | streaming, tools, JSON, vision, cache usage | ENG-1415 interactive |
| Agent Mode internal scoring/content callers | `services/reportClassificationService.ts`, `services/sessionScoringService.ts`, `services/sessionSummaryService.ts`, `services/dedupService.ts`, `services/socialPostsService.ts`, plus internal calls in `services/agentModeService.ts` | `AgentModeService.callLLM`; logical model comes from the model registry, AW-Settings defaults, or the named caller constant, then follows the Agent Mode provider branches above | text, JSON, judge output, metering | ENG-1415 interactive/judge |
| Agent Mode native Gemini shim | `services/agentMode/core/geminiNativeClient.ts` | `@google/genai` -> Gemini key path above; caller supplies a `gemini-*` registry ID | tools, structured output, usage, thought filtering | ENG-1415 interactive |
| Emma sidebar chat | `services/chatbotService.ts` | `getAzureClient` -> Azure env deployment by default; Agent Mode Bedrock/Gemini clients for `anthropic.*`/`claude-*` and `gemini-*`; selected model is the session/user logical ID | tools, streaming-shaped loop, retries, explicit metering | ENG-1415 interactive |
| Scheduled social and CRM helpers | `cron/socialEngagementExecutor.ts`, `routes/crm.ts` | Agent Mode Gemini OpenAI-compatible client -> Gemini key path; model IDs are the call-site/session-selected `gemini-*` values | text, JSON/content | ENG-1415 scheduled |
| Scheduled/task/workflow Azure callers | `cron/linkedInConnectionSyncCron.ts`, `routes/tasks.ts`, `services/workflowGenerator.ts`, `services/growthGeniusService.ts`, `services/reportRevisionService.ts`, `services/inviteNoteShortener.ts` | OpenAI-compatible client from `llmClients`/service wrapper -> Azure env endpoint/key/deployment; model is the call-site constant or deployment env value | text, structured output, retries | ENG-1415 scheduled/content |
| Native Gemini content/API callers | `controllers/blog.ts`, `routes/slack.ts`, `services/deepResearchService.ts` | `@google/genai` via `getGeminiClient` -> explicit key or `GEMINI_API_KEY`; call-site `gemini-*` model | long text, JSON, multimodal input | ENG-1415 content/MCP/API |
| CRM enrichment, field alias, and clustering | `services/crmEnrichmentService.ts`, `services/enrichmentFieldAliasService.ts`, `services/enrichmentClusterService.ts` | `AgentModeService.getClientForModel`; AW-Settings/caller logical ID selects Bedrock, Azure, Vertex, OpenRouter, or Gemini credential path above | structured output, retries, metering | ENG-1415 judge/dedup/scoring |
| RCA/eval-funnel enrichment | `loops/instances/ai-eval-funnel/rcaEnricher.ts` | Bedrock SDK via `llmClients` -> workload IAM/env AWS credentials; fixed Sonnet inference-profile ID | JSON, timeout, cache marker, metering | ENG-1415 remaining callers |
| Shared LLM/onboarding service | `utils/llmService.ts`, `cron/onboardingLoop.ts`, `services/onboardingLoopAgents.ts` | LangChain Azure/Bedrock/Gemini clients -> Azure env, workload IAM, or Gemini secret; model comes from service configuration/caller | streaming, JSON, metering | ENG-1415 remaining callers |
| Metered construction factory | `utils/llmClients.ts` | OpenAI SDK (OpenAI/Azure env), Bedrock SDK (workload IAM/env), and Google SDK (`GEMINI_API_KEY`); caller supplies provider-native model/deployment | usage normalization and exactly-once recording | ENG-1415 deletion after callers move |
| MCP workflow tools | `mcp/server/workflowTools.ts` and Agent Mode callers | inherited `AgentModeService.callLLM` logical model and credentials | tools, structured output | ENG-1415 MCP/API |
| Coding/cloud agent | `services/codingAgentService.ts` | Anthropic SDK -> Bedrock/Vertex credentials and provider-native Claude IDs selected by coding-agent configuration | tools, long-running streams, cache | ENG-1416 coding |
| Agent-engine model factory | `agent-engine/task_utils.py` | LangChain Bedrock, Azure, OpenAI, DeepSeek, PLD, and Gemini clients -> `secrets_manager` provider credentials; `platform->provider->model` task ID selects the factory/model | browser tools, vision, structured output | ENG-1416 agent engine |
| Agent-engine monitor | `agent-engine/task_monitor.py` | OpenAI `AzureOpenAI` plus `task_utils.get_azure_openai_llm3` -> `secrets_manager` Azure endpoint/key/version; task/call-site deployment ID | monitoring summaries and task control | ENG-1416 agent engine |
| Agent-engine web actions | `agent-engine/web_agent.py` | LangChain Bedrock/Azure/OpenAI factories from `task_utils`; direct OpenAI key for the GPT consultation action; task `full_llm_name` carries `platform->provider->model` | browser-tool workflow, vision, auxiliary reasoning | ENG-1416 agent engine |

## Narrow non-text exceptions

| Exception | Missing OpenRouter capability evidence | Owner | Review date | Removal condition | Call sites |
| --- | --- | --- | --- | --- | --- |
| Gemini Live voice | OpenRouter's chat gateway does not provide the bidirectional live-audio session used by `ai.live.connect`. This exception excludes ordinary Gemini text generation. | ENG-1416 | 2026-09-20 | OpenRouter supports the required realtime audio/session semantics and parity passes. | `services/liveVoiceService.ts` |
| Veo video generation | Video generation is not a supported text/chat/tool completion and is billed per video, not completion tokens. | ENG-1416 | 2026-09-20 | OpenRouter offers the required video generation contract and parity passes. | `services/videoGeneration.ts` |
| Embeddings | Embedding vectors are not chat completions and use a dedicated Azure deployment/index contract. | ENG-1416 | 2026-09-20 | The selected managed gateway supports the required embedding model and vector dimensions with parity. | `utils/embeddings.ts`, embedding path in `services/chatbotService.ts` |
| Image generation/editing | OpenAI, Azure image, and Gemini image calls return binary/media artifacts rather than the text/chat/tool response contract. | ENG-1416 | 2026-09-20 | OpenRouter supports the required image models, edits, references, and binary response handling with parity. | `services/imageGeneration.ts`, image actions in `agent-engine/web_agent.py` |

## Baseline evidence completed before consumer cutover

ENG-1423's executable fixtures and observed matrix live in
`src/loops/eval/openRouterBaselineEvidence.ts` and
`eval-artifacts/openrouter-baseline/eng1423-9354ce5c6.json`. The shared
`GATEWAY_TASK_CLASSES` taxonomy is the single source used by both the gateway
contract and those fixtures. Each traffic-moving slice must now compare against
that baseline with Okareo, shared staging, and a bounded live matrix before its
direct transport is deleted.
